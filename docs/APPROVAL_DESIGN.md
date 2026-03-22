# Approval System Design / 审批系统设计

[English](#english) | [中文](#中文)

---

## English

### The Problem

AI coding agents (Claude, Codex, etc.) can read files, write code, and execute shell commands. When running unattended through a chat bridge, every tool call that could modify state — a file write, a `git push`, a `pip install`, a `docker restart` — is a potential risk.

The standard approach in CLI usage is simple: the agent pauses and asks the human sitting at the terminal. But in a chat bridge scenario, the "terminal" is a Feishu group chat. The human may be on their phone, asleep, or handling multiple conversations. We need an approval system that:

1. **Does not block on every read** — `ls`, `cat`, `git log` should just run
2. **Catches dangerous writes** — `rm -rf`, `git push --force`, service restarts must require human confirmation
3. **Handles the gray area** — complex commands that are probably safe but not obviously so
4. **Works across different runners** — Claude SDK has a native permission callback; Codex has no such API

### Architecture Overview

```
                        ┌─────────────────┐
                        │   Tool Request   │
                        │  (Bash, Write,   │
                        │   Edit, etc.)    │
                        └────────┬────────┘
                                 │
                    ┌────────────▼────────────┐
                    │  Layer 1: Rule Engine    │
                    │  claude-bash-readonly.mjs│
                    │                         │
                    │  BLOCKED_PATTERNS →      │
                    │    immediate "manual"    │
                    │  ALLOWED_PATTERNS →      │
                    │    immediate "allow"     │
                    │  neither → "unknown"     │
                    └────────────┬────────────┘
                                 │ unknown
                    ┌────────────▼────────────┐
                    │  Layer 2: Gemini LLM    │
                    │  gemini-readonly.mjs     │
                    │  (optional, off by      │
                    │   default)              │
                    │                         │
                    │  readonly + high conf →  │
                    │    auto-allow            │
                    │  else → fall through     │
                    └────────────┬────────────┘
                                 │ still uncertain
                    ┌────────────▼────────────┐
                    │  Layer 3: Human Review   │
                    │  Feishu card buttons     │
                    │  + text fallback         │
                    │                         │
                    │  Approve once            │
                    │  Approve + remember      │
                    │  Reject                  │
                    │  (10 min timeout)        │
                    └─────────────────────────┘
```

### Two Different Runners, Two Different Mechanisms

#### Claude SDK: Native `canUseTool` Callback

The Claude Agent SDK provides a first-class permission hook: `canUseTool(tool, input, options)`. Every time Claude wants to use a tool, the SDK calls this function and waits for a response before proceeding.

In `claude-sdk.mjs`, the `canUseTool` callback is wired directly into the three-layer classification:

```js
canUseTool: async (tool, input, options) => {
  if (toolName === 'Bash') {
    // Layer 1: rule-based classification
    const result = classifyReadOnlyBashInput(input);
    if (result.verdict === 'allow') return { behavior: 'allow' };
    // Layer 2: Gemini classification (if enabled)
    if (result.verdict === 'unknown') {
      const gemini = await geminiClassifier.classifyCommand(command);
      if (geminiClassifier.shouldAutoAllow(gemini)) return { behavior: 'allow' };
    }
  }
  // Layer 3: human approval via Feishu card
  const decision = await callbacks.requestApproval({ ... });
  // ...
}
```

This is clean — the SDK does the pausing and resuming, the bridge just decides.

#### Codex: Prompt-Injected Checkpoint Pattern

Codex has **no native permission callback**. It runs as a child process that streams JSON events on stdout. When Codex wants to do something risky, it just does it (if `--dangerously-bypass-approvals-and-sandbox` is set) or blocks waiting for stdin input (which we cannot provide through the bridge).

**Our solution: inject a checkpoint protocol into the system prompt.**

The idea is to make Codex *think* it should pause and ask for permission by teaching it a structured output pattern through the system prompt. This is effectively a **prompt-based approval protocol**:

1. The bridge injects instructions into the Codex system prompt (via `BRIDGE_CODEX_SYSTEM_PROMPT_FILE` or `BRIDGE_CODEX_SYSTEM_PROMPT`) that tell Codex to output a "Checkpoint" block before performing any state-changing action
2. The bridge watches Codex's stdout event stream for messages matching the checkpoint pattern
3. When detected, the bridge captures the checkpoint text, creates an approval card in Feishu, and waits for the human's response
4. The human's response (`confirm`, `skip`, `revise`) is fed back to Codex as the next prompt in a `resume` session

The checkpoint pattern the prompt teaches Codex to output:

```
Checkpoint
- action: <what will change>
- scope: <host/service/file>
- why: <reason>
- exact command(s): <the commands>
- expected effect: <what will happen>
- reversible: <yes/no>

Reply "confirm" to proceed.
Reply "skip" to skip this and continue the rest of the task.
Reply "revise" for a safer alternative.
```

The detection logic in `request-executor.mjs` (`extractCodexCheckpoint`) finds a line starting with "Checkpoint" anywhere in the text (the model sometimes prepends analysis/discussion), then validates structural markers (`- action:`, `- scope:`, `- why:`, etc.) or decision cues (`Reply "confirm"`, etc.). If >= 4 structural markers are found, it is treated as a checkpoint.

The resolution flow:

```
Codex stdout ──JSON events──→ Bridge
                                │
                    extractCodexCheckpoint()
                                │
                          checkpoint found?
                          ┌─────┴─────┐
                         yes          no
                          │            │
              create approval     post as normal
              card in Feishu      interim message
                          │
                    human responds
                  (confirm/skip/revise)
                          │
              resume Codex session
              with decision as prompt
                          │
              Codex continues or
              takes alternative action
```

**Why prompt injection instead of stdin piping?**

- Codex's stdin approval protocol is undocumented and fragile
- The JSON event stream on stdout is stable and parseable
- Prompt injection lets us define our own protocol with richer semantics (the checkpoint includes *why*, *scope*, *reversibility* — not just yes/no)
- The same prompt pattern works across Codex versions without depending on internal APIs
- Session resume (`codex exec resume <session_id> -- <prompt>`) is the official way to continue a conversation, and passing the decision as the next user prompt is natural

**Trade-off**: This approach depends on the model faithfully following the prompt instructions. A sufficiently capable model will almost always output checkpoints when instructed, but it is not a hard guarantee — the model could theoretically skip the checkpoint and act directly. For truly dangerous operations, the Codex `--dangerously-bypass-approvals-and-sandbox` flag should NOT be set, so the Codex sandbox provides a second layer of protection.

### Layer 1: Rule-Based Classification

`claude-bash-readonly.mjs` implements a deterministic three-outcome classifier for shell commands:

**Outcome `manual`** — Command matches `BLOCKED_PATTERNS` (known-dangerous). Skip all further classification, go straight to human approval. Examples:
- `rm`, `mv`, `chmod`, `kill`, `reboot`
- `systemctl start/stop/restart`
- `docker run/build/up/down`
- `git add/commit/push/checkout/reset`
- `npm install/remove`
- `curl -X POST`, `curl --data`
- Output redirection `>`, `>>` (except `>/dev/null`)
- Command substitution `` `...` ``, `$(...)`
- Here-documents `<<EOF`
- Subshell execution `bash -c`, `sh -c`

**Outcome `allow`** — Every segment of the command (split by `;`, `|`, `&&`) matches `ALLOWED_SEGMENT_PATTERNS` (known-readonly). Auto-approve immediately. Examples:
- `ls`, `cat`, `head`, `tail`, `grep`, `find`, `wc`, `sort`, `uniq`
- `ps`, `free`, `uptime`, `df`, `du`
- `git log`, `git show`, `git remote -v`, `git branch --show-current`
- `systemctl status/is-active/list-units`
- `docker ps`, `docker compose ls`
- `npm list`, `pip list/show/freeze`
- Version checks: `<any-binary> --version`
- `sed` without `-i` flag
- `awk` with only `print`/`printf` (no `system()`, `getline`, file output)
- Remote readonly: `ssh host 'cat /var/log/...'` (recursively classified)

**Outcome `unknown`** — Does not match either list. Falls through to Layer 2 (Gemini) or Layer 3 (human).

The classifier handles pipeline commands by splitting on `;`, `|`, `&&` and checking each segment independently. It also:
- Strips leading environment variable assignments (`FOO=bar command`)
- Strips trailing safe redirections (`2>/dev/null`, `2>&1`)
- Recursively classifies SSH remote commands (extracts the quoted command body and re-classifies it)

### Layer 2: Gemini LLM Classifier (Optional)

When the rule engine returns `unknown`, the command might still be safe — it just was not in the allowlist. Examples:
- `python3 -c "import sys; print(sys.version)"`
- `node -e "console.log(process.versions)"`
- `jq '.dependencies' package.json`

Rather than asking the human for every unfamiliar-but-harmless command, we optionally send it to a fast, cheap LLM (Gemini Flash Lite) for a second opinion.

**Why Gemini, not Claude itself?**

- **Cost**: Gemini Flash Lite is extremely cheap. We may classify hundreds of commands per session.
- **Speed**: Flash Lite responds in 200-500ms. Claude would add 2-5 seconds per classification.
- **Separation of concerns**: The agent (Claude) should not judge its own tool calls. Using a separate model avoids the agent "persuading itself" that a dangerous command is safe.

**How it works:**

1. Command sent to Gemini with a strict system prompt defining "readonly"
2. Gemini returns JSON: `{ "readonly_probability": 0-100, "verdict": "readonly|non_readonly|uncertain", "reason": "..." }`
3. Bridge checks if `verdict === "readonly"` AND `readonly_probability >= threshold`
4. Default threshold is `100` (most conservative: require absolute confidence)

**Failure semantics**: If Gemini is unreachable, times out, or returns invalid JSON, the command falls through to human approval. The classifier **never auto-approves on error**.

**Key rotation**: Multiple API keys can be provided (`BRIDGE_CLAUDE_GEMINI_API_KEYS=key1,key2,key3`). The classifier rotates through them round-robin and falls back to the next key on failure.

### Layer 3: Human Approval via Feishu

When neither rule engine nor Gemini can auto-approve, the bridge posts an interactive card in Feishu.

**For tool approvals (Claude SDK `canUseTool`):**

An orange card titled "approval required" with session/command details and three buttons: Approve once, Approve + remember, Reject. Text fallback: reply `1`, `2`, or `3`.

**For checkpoints (Codex prompt-injected):**

A purple card titled "checkpoint" with the full checkpoint text and three buttons: Confirm, Skip, Revise. Text fallback: reply `confirm`, `skip`, or `revise`. Chinese text aliases also work: `同意一次`, `一直同意`, `拒绝`.

**Resolution channels:**
1. **Card button click** — Feishu sends a card action callback; the bridge resolves the approval immediately
2. **Text reply fallback** — If card buttons fail (e.g. card action callback not configured), the user can reply with text
3. **Timeout** — If no response within 10 minutes, the approval expires and the tool call is rejected

**Card schema note:** Approval cards use Feishu's legacy card layout (without `schema: '2.0'`) because schema 2.0 rejects interactive `action` button blocks. Normal reply cards use schema 2.0 for better markdown rendering.

### Approval Decisions

| Decision | Tool approval | Checkpoint |
|----------|--------------|------------|
| **Approve once** / **Confirm** | Allow this single tool call | Continue past the checkpoint |
| **Approve + remember** | Allow and add the tool to the session's allowed list | — |
| **Reject** / **Skip** | Deny the tool call; agent gets error message | Skip this action, continue with rest |
| — / **Revise** | — | Ask agent for a safer alternative |

### Design Decisions and Trade-offs

| Decision | Rationale |
|----------|-----------|
| Rule engine first, LLM second | Deterministic rules are free, fast, and auditable. LLM is only for the gray area. |
| Gemini off by default | Conservative default. Users opt in after understanding the risk. |
| Threshold default 100 | Even with Gemini enabled, require maximum confidence to auto-approve. |
| Separate model for classification | Avoid the agent judging its own actions. |
| Prompt injection for Codex | No native API; prompt-based protocol is version-independent and rich. |
| Legacy card schema for buttons | Feishu schema 2.0 does not support action buttons; pragmatic choice. |
| Text fallback for approval | Card action callback requires additional Feishu app config; text always works. |
| 10-minute timeout | Long enough for async review, short enough to not block indefinitely. |
| Any user can approve | Intentional for team use — any team member can unblock the agent. May add role restrictions later. |

---

## 中文

### 要解决的问题

AI 编程 Agent（Claude、Codex 等）能读文件、写代码、执行 shell 命令。当它们通过聊天 Bridge 无人值守运行时，每个可能修改状态的工具调用——写文件、`git push`、`pip install`、`docker restart`——都是潜在风险。

CLI 场景下方案很简单：Agent 暂停，等坐在终端前的人确认。但在聊天 Bridge 场景下，"终端"是飞书群聊，用户可能在用手机、在睡觉、或在同时处理多个对话。我们需要一个审批系统：

1. **不阻塞只读操作** —— `ls`、`cat`、`git log` 应该直接执行
2. **拦截危险写入** —— `rm -rf`、`git push --force`、服务重启必须人工确认
3. **处理灰色地带** —— 可能安全但不明显的复杂命令
4. **跨 Runner 工作** —— Claude SDK 有原生权限回调；Codex 没有这种 API

### 架构概览

```
                        ┌──────────────────┐
                        │    工具请求       │
                        │  (Bash, Write,   │
                        │   Edit 等)       │
                        └────────┬─────────┘
                                 │
                    ┌────────────▼─────────────┐
                    │  第一层：规则引擎          │
                    │  claude-bash-readonly.mjs │
                    │                          │
                    │  黑名单匹配 → 直接"人工"   │
                    │  白名单匹配 → 直接"放行"   │
                    │  都不匹配   → "未知"       │
                    └────────────┬─────────────┘
                                 │ 未知
                    ┌────────────▼─────────────┐
                    │  第二层：Gemini LLM 分类   │
                    │  gemini-readonly.mjs      │
                    │  （可选，默认关闭）        │
                    │                          │
                    │  只读 + 高置信度 → 放行    │
                    │  否则 → 继续下沉          │
                    └────────────┬─────────────┘
                                 │ 仍不确定
                    ┌────────────▼─────────────┐
                    │  第三层：人工审批          │
                    │  飞书交互卡片按钮          │
                    │  + 文字回复兜底           │
                    │                          │
                    │  批准一次 / 批准并记住     │
                    │  拒绝                     │
                    │  （10 分钟超时）           │
                    └──────────────────────────┘
```

### 两种 Runner，两种机制

#### Claude SDK：原生 `canUseTool` 回调

Claude Agent SDK 提供一等公民的权限钩子：`canUseTool(tool, input, options)`。Claude 每次使用工具前，SDK 都会调用这个函数并等待返回。

在 `claude-sdk.mjs` 中，`canUseTool` 回调直接对接三层分类。这很干净——SDK 负责暂停和恢复，Bridge 只负责做决策。

#### Codex：Prompt 注入的 Checkpoint 协议

Codex **没有原生权限回调 API**。它作为子进程运行，通过 stdout 输出 JSON 事件流。当 Codex 想做有风险的事时，它要么直接做（如果设了 `--dangerously-bypass-approvals-and-sandbox`），要么阻塞等 stdin 输入（Bridge 无法提供）。

**我们的方案：通过 system prompt 注入一个 checkpoint 协议。**

核心思路是，通过 system prompt 教会 Codex 在执行危险操作前主动输出一个结构化的"Checkpoint"格式。这本质上是一个**基于 prompt 的审批协议**：

1. Bridge 在 Codex 的 system prompt 中注入指令（通过 `BRIDGE_CODEX_SYSTEM_PROMPT_FILE`），告诉 Codex 在执行任何改变状态的操作前，输出一个结构化的 Checkpoint 块
2. Bridge 实时监听 Codex 的 stdout 事件流，检测是否包含 checkpoint 模式
3. 检测到 checkpoint 后，Bridge 在飞书中创建审批卡片，等待人工响应
4. 人工回复（`confirm`、`skip`、`revise`）通过 session resume 传回 Codex 作为下一轮 prompt

Bridge 教 Codex 输出的 checkpoint 格式：

```
Checkpoint
- action: <要做什么>
- scope: <影响范围>
- why: <为什么>
- exact command(s): <具体命令>
- expected effect: <预期效果>
- reversible: <是否可逆>

Reply "confirm" to proceed.
Reply "skip" to skip this and continue the rest of the task.
Reply "revise" for a safer alternative.
```

检测逻辑在 `request-executor.mjs` 的 `extractCodexCheckpoint` 中：在文本中查找以 "Checkpoint" 开头的行，然后验证结构化标记（`- action:`、`- scope:`、`- why:` 等）或决策提示（`Reply "confirm"` 等）。如果找到 >= 4 个结构化标记，判定为 checkpoint。

决策回传流程：

```
Codex stdout ──JSON 事件──→ Bridge
                               │
                   extractCodexCheckpoint()
                               │
                         发现 checkpoint？
                         ┌─────┴─────┐
                        是           否
                         │            │
             创建审批卡片       作为普通中间
             发送到飞书        消息发送
                         │
                   人工回复
                 (confirm/skip/revise)
                         │
             resume Codex session
             将决策作为下一轮 prompt
                         │
             Codex 继续或采取替代方案
```

**为什么用 prompt 注入而不是 stdin 管道？**

- Codex 的 stdin 审批协议未文档化且不稳定
- stdout 的 JSON 事件流是稳定的、可解析的
- Prompt 注入让我们定义自己的协议，语义更丰富（checkpoint 包含 *why*、*scope*、*reversibility*——不只是 yes/no）
- 同样的 prompt 模式跨 Codex 版本通用，不依赖内部 API
- Session resume（`codex exec resume <session_id> -- <prompt>`）是官方的会话续接方式，把决策作为下一轮 user prompt 传入是自然的

**折中**：这种方案依赖模型忠实遵循 prompt 指令。能力足够强的模型几乎总会按要求输出 checkpoint，但不是硬保证——理论上模型可能跳过 checkpoint 直接执行。对真正危险的操作，不应该设置 `--dangerously-bypass-approvals-and-sandbox`，这样 Codex 的沙箱本身提供第二层保护。

### 第一层：规则引擎详解

`claude-bash-readonly.mjs` 实现了一个确定性的三结果分类器：

**结果 `manual`**（黑名单命中）—— 已知危险命令，跳过所有后续分类，直接人工审批：
- `rm`、`mv`、`chmod`、`kill`、`reboot`
- `systemctl start/stop/restart`
- `docker run/build/up/down`
- `git add/commit/push/checkout/reset`
- `npm install/remove`
- `curl -X POST`、`curl --data`
- 输出重定向 `>`、`>>`（`>/dev/null` 除外）
- 命令替换 `` `...` ``、`$(...)`
- Here-document `<<EOF`
- 子 shell 执行 `bash -c`、`sh -c`

**结果 `allow`**（白名单命中）—— 命令的每个段都是已知只读命令，立即自动放行：
- `ls`、`cat`、`head`、`tail`、`grep`、`find`、`wc`、`sort`、`uniq`
- `ps`、`free`、`uptime`、`df`、`du`
- `git log`、`git show`、`git remote -v`
- `systemctl status/is-active/list-units`
- `docker ps`、`docker compose ls`
- `npm list`、`pip list/show/freeze`
- 版本检查：`<任意二进制> --version`
- 不带 `-i` 的 `sed`
- 只有 `print`/`printf` 的 `awk`（无 `system()`、`getline`、文件输出）
- 远程只读：`ssh host 'cat /var/log/...'`（递归分类引号内的远程命令）

**结果 `unknown`**（都不匹配）—— 下沉到第二层或第三层。

分类器通过 `;`、`|`、`&&` 分割管道命令，逐段独立检查。还会：
- 剥离前导环境变量赋值（`FOO=bar command`）
- 剥离尾部安全重定向（`2>/dev/null`、`2>&1`）
- 递归分类 SSH 远程命令（提取引号内的命令体重新分类）

### 第二层：Gemini LLM 分类器（可选）

规则引擎返回 `unknown` 时，命令可能仍然是安全的——只是不在白名单里。例如：
- `python3 -c "import sys; print(sys.version)"`
- `jq '.dependencies' package.json`

与其让人审批每一个不熟悉但无害的命令，不如可选地让一个快速、便宜的 LLM（Gemini Flash Lite）给个第二意见。

**为什么用 Gemini 而不是 Claude 自己？**

- **成本**：Gemini Flash Lite 极其便宜。一个会话可能分类几百个命令。
- **速度**：Flash Lite 200-500ms 响应。Claude 每次分类需要 2-5 秒。
- **关注点分离**：Agent（Claude）不应该判断自己的工具调用。用独立模型避免 Agent "说服自己"危险命令是安全的。

**工作方式：**

1. 将命令发给 Gemini，附带严格的 system prompt 定义"只读"
2. Gemini 返回 JSON：`{ "readonly_probability": 0-100, "verdict": "readonly|non_readonly|uncertain", "reason": "..." }`
3. Bridge 检查 `verdict === "readonly"` 且 `readonly_probability >= threshold`
4. 默认阈值为 `100`（最保守：要求绝对置信度）

**失败语义**：如果 Gemini 不可达、超时、或返回无效 JSON，命令下沉到人工审批。分类器**永远不会在出错时自动放行**。

**密钥轮转**：可提供多个 API key（`BRIDGE_CLAUDE_GEMINI_API_KEYS=key1,key2,key3`）。分类器 round-robin 轮转，某个 key 失败时自动切换到下一个。

### 第三层：飞书人工审批

规则引擎和 Gemini 都无法自动放行时，Bridge 在飞书发送交互卡片。

**工具审批**（Claude SDK `canUseTool`）：橙色卡片，标题"approval required"，显示 session/command 详情，三个按钮：Approve once、Approve + remember、Reject。文字兜底：回复 `1`、`2` 或 `3`。

**Checkpoint 审批**（Codex prompt 注入）：紫色卡片，标题"checkpoint"，显示完整 checkpoint 文本，三个按钮：Confirm、Skip、Revise。文字兜底：回复 `confirm`、`skip` 或 `revise`。也支持中文：`同意一次`、`一直同意`、`拒绝`。

**审批解决渠道：**
1. **卡片按钮点击** —— 飞书发送卡片交互回调；Bridge 立即解决审批
2. **文字回复兜底** —— 如果卡片按钮不可用，用户可回复文字
3. **超时** —— 10 分钟无响应，审批过期，工具调用被拒绝

**卡片 schema 说明**：审批卡片使用飞书旧版卡片布局（不带 `schema: '2.0'`），因为 schema 2.0 不支持交互式 `action` 按钮。普通回复卡片使用 schema 2.0 以获得更好的 markdown 渲染。

### 审批决策

| 决策 | 工具审批 | Checkpoint |
|------|---------|------------|
| **批准一次** / **Confirm** | 允许此次工具调用 | 继续通过 checkpoint |
| **批准并记住** | 允许并加入会话允许列表 | — |
| **拒绝** / **Skip** | 拒绝工具调用；Agent 收到错误信息 | 跳过此操作，继续其余任务 |
| — / **Revise** | — | 要求 Agent 给出更安全的方案 |

### 设计决策与折中

| 决策 | 理由 |
|------|------|
| 规则引擎优先，LLM 其次 | 确定性规则免费、快速、可审计。LLM 只用于灰色地带。 |
| Gemini 默认关闭 | 保守默认值。用户理解风险后主动启用。 |
| 阈值默认 100 | 即使启用 Gemini，也要求最高置信度才自动放行。 |
| 用独立模型做分类 | 避免 Agent 判断自己的行为。 |
| Codex 用 prompt 注入 | 无原生 API；基于 prompt 的协议跨版本通用且语义丰富。 |
| 审批卡片用旧版 schema | 飞书 schema 2.0 不支持交互按钮；务实选择。 |
| 文字回复兜底 | 卡片交互回调需要额外配置飞书应用；文字始终可用。 |
| 10 分钟超时 | 足够异步审批，又不会无限阻塞。 |
| 任何用户可审批 | 面向团队使用——任何成员都能解除阻塞。后续可能加角色限制。 |
