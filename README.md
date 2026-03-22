# claude-codex-bridge-feishu

[English](#english) | [中文](#中文)

---

## English

Feishu-native bridge for Claude, Codex, and compatible CLI/SDK runners.

Receive messages from Feishu (Lark), route them through a request queue with approval control, execute via Claude SDK / Codex / Kimi runners, and reply with rich-text or interactive cards.

### Prerequisites

| Requirement | Notes |
|-------------|-------|
| **Node.js >= 22** | Required. Check with `node -v` |
| **npm** | Comes with Node.js |
| **tmux** | Required by `scripts/start-instance.sh` for process management |
| **Feishu custom app** | You need a Feishu (Lark) custom app with bot capability enabled |
| **Public URL / reverse proxy** | The bridge listens on HTTP; you need nginx, Caddy, or similar to expose it with HTTPS for Feishu callbacks |

#### Runner-specific prerequisites

| Runner | Extra requirement |
|--------|-------------------|
| `claude-sdk` | `ANTHROPIC_API_KEY` in environment (used by `@anthropic-ai/claude-agent-sdk`) |
| `codex` | `codex` CLI installed globally (`npm i -g @anthropic-ai/codex`) |
| `kimi` | `kimi-cli` binary installed locally |

### Quick Start

```bash
# 1. Clone and install
git clone https://github.com/suntanzer/claude-codex-bridge-feishu.git
cd claude-codex-bridge-feishu
npm install

# 2. Create instance env from example
cp .env.example instances/claude.env

# 3. Edit instances/claude.env — fill in at minimum:
#    FEISHU_APP_ID=cli_xxxxx
#    FEISHU_APP_SECRET=xxxxx
#    BRIDGE_RUNNER=claude-sdk
#    BRIDGE_DEFAULT_CWD=/path/to/your/workdir
#    FEISHU_PUBLIC_BASE_URL=https://your-domain.com

# 4. Start the bridge (runs in a tmux session)
./scripts/start-instance.sh claude

# 5. Check status
./scripts/status-instance.sh claude

# 6. Stop
./scripts/stop-instance.sh claude
```

### Minimal Configuration

The absolute minimum to get a working bridge:

```env
# instances/claude.env

# --- Required: Feishu app credentials ---
FEISHU_APP_ID=cli_xxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx

# --- Required: runner selection ---
BRIDGE_RUNNER=claude-sdk

# --- Required: working directory for the runner ---
BRIDGE_DEFAULT_CWD=/home/user/projects

# --- Required for approval buttons to work ---
FEISHU_PUBLIC_BASE_URL=https://your-domain.com
```

With this config the bridge will:
- Listen on `0.0.0.0:8770` at path `/feishu/events/default`
- Use Claude SDK as the runner (requires `ANTHROPIC_API_KEY` in your environment)
- Store state in `./data/default/store.json`

### Feishu App Setup

1. Go to [Feishu Open Platform](https://open.feishu.cn/) and create a custom app
2. Enable **Bot** capability
3. Under **Event Subscriptions**, set the Request URL to:
   ```
   https://your-domain.com/feishu/events/bridge
   ```
   (Must match `FEISHU_PUBLIC_BASE_URL` + `FEISHU_CALLBACK_PATH`)
4. Subscribe to these events:
   - `im.message.receive_v1` — receive messages
   - `p2p_chat_create` — (optional) detect new P2P chats
5. Under **Permissions**, grant:
   - `im:message` — send and receive messages
   - `im:message:send_as_bot` — send messages as bot
   - `im:resource` — access message resources
   - `im:chat` — access chat info
6. If using card action buttons (approval flow), configure the **Card Action** callback URL to the same endpoint
7. Copy the **App ID**, **App Secret**, **Verification Token**, and **Encrypt Key** into your instance env file

### Reverse Proxy Example (nginx)

```nginx
server {
    listen 443 ssl;
    server_name your-domain.com;

    ssl_certificate     /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location /feishu/ {
        proxy_pass http://127.0.0.1:8770;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### Multi-Instance

You can run multiple bridge instances with different runners or Feishu apps:

```bash
# Create separate env files
cp .env.example instances/claude.env   # Claude SDK runner
cp .env.example instances/codex.env    # Codex runner

# Use different ports and callback paths
# In instances/claude.env:
#   FEISHU_CALLBACK_PORT=8770
#   FEISHU_CALLBACK_PATH=/feishu/events/claude
# In instances/codex.env:
#   FEISHU_CALLBACK_PORT=8771
#   FEISHU_CALLBACK_PATH=/feishu/events/codex

# Shared config goes in instances/common.env (optional)

# Start each instance
./scripts/start-instance.sh claude
./scripts/start-instance.sh codex
```

### Approval Behavior

AI coding agents can execute shell commands and modify files. When running unattended through a chat bridge, every state-changing tool call is a potential risk. The bridge implements a **three-layer approval architecture** that auto-approves safe reads, catches dangerous writes, and handles the gray area in between:

1. **Layer 1 — Rule engine** (`claude-bash-readonly.mjs`): deterministic pattern matching. Known-safe commands (`ls`, `cat`, `git log`, `grep`, etc.) are auto-approved immediately. Known-dangerous commands (`rm`, `git push`, `systemctl restart`, output redirects, etc.) go straight to human review. Pipeline commands are split and each segment is checked independently; SSH remote commands are recursively classified.
2. **Layer 2 — Gemini LLM classifier** (`gemini-readonly.mjs`, optional, off by default): for commands the rule engine cannot decide, a fast/cheap external model (Gemini Flash Lite) gives a second opinion. A separate model is used instead of Claude itself to avoid the agent judging its own actions. Only auto-approves when confidence meets the threshold (default: 100%, most conservative). **Never auto-approves on error** — any failure falls through to human review.
3. **Layer 3 — Human approval via Feishu**: an interactive card with Approve / Reject / Skip buttons, plus a text fallback (`1`/`2`/`3` or `confirm`/`skip`/`revise`). 10-minute timeout; any team member can respond.

**Claude SDK vs Codex — two different mechanisms:**

- **Claude SDK** has a native `canUseTool` callback. The SDK pauses, the bridge classifies through the three layers, and returns the decision. Clean and API-supported.
- **Codex** has no permission callback API. The bridge solves this by **injecting a checkpoint protocol into the system prompt**: Codex is taught to output a structured "Checkpoint" block before any state-changing action. The bridge detects this pattern in the stdout event stream, posts an approval card in Feishu, and feeds the human's decision back via `codex exec resume` as the next user prompt. This is effectively a prompt-based approval protocol — version-independent, richer than stdin yes/no, and works without relying on undocumented internal APIs.

Enable the Gemini classifier with:
```env
BRIDGE_CLAUDE_GEMINI_READONLY_ENABLED=true
BRIDGE_CLAUDE_GEMINI_API_KEY=your-gemini-api-key
BRIDGE_CLAUDE_GEMINI_READONLY_THRESHOLD=100
```

For the full design rationale, data flow diagrams, rule lists, and trade-off analysis, see **[docs/APPROVAL_DESIGN.md](docs/APPROVAL_DESIGN.md)**.

### Operational Commands

Send these in Feishu chat (default prefix `!bridge`):

| Command | Description |
|---------|-------------|
| `!bridge status` | Show bridge status, active request, queue |
| `!bridge current` | Show current running request details |
| `!bridge cancel` | Cancel the active request |
| `!bridge doctor` | Run health diagnostics |

### Repository Layout

```
src/
  app/           # Main entry, config, event handler, request executor
  approval/      # Approval store, service, UI builders
  ops/           # Operational commands (!bridge status, etc.)
  requests/      # Request queue and service
  runner/        # Runner adapters (Claude SDK, Codex, Kimi, etc.)
  store/         # JSON persistence layer
  transport/     # Feishu client, webhook server, cards, routing
  util/          # Logging, text chunking, ID generation, time helpers
test/            # Node.js built-in test runner tests
scripts/         # Instance start/status/stop scripts (tmux-based)
instances/       # Instance env files (gitignored except examples)
docs/            # Audit documents and notes
```

### Environment Variables Reference

See [`.env.example`](.env.example) for the complete list with comments. Key groups:

| Group | Variables | Required |
|-------|-----------|----------|
| Feishu credentials | `FEISHU_APP_ID`, `FEISHU_APP_SECRET` | Yes |
| Feishu security | `FEISHU_VERIFICATION_TOKEN`, `FEISHU_ENCRYPT_KEY` | Recommended |
| Callback server | `FEISHU_CALLBACK_PORT`, `FEISHU_CALLBACK_PATH`, `FEISHU_PUBLIC_BASE_URL` | Port has default; URL needed for approval buttons |
| Message filtering | `FEISHU_ALLOWED_CHAT_IDS`, `FEISHU_ALLOWED_OPEN_IDS`, `FEISHU_GROUP_MODE` | Optional |
| Bridge runtime | `BRIDGE_RUNNER`, `BRIDGE_DEFAULT_CWD`, `BRIDGE_DATA_DIR` | Runner and CWD recommended |
| Claude runner | `BRIDGE_CLAUDE_MODEL`, `BRIDGE_CLAUDE_THINKING_MODE`, etc. | Optional |
| Codex runner | `BRIDGE_CODEX_BIN`, `BRIDGE_CODEX_MODEL`, etc. | Optional |
| Kimi runner | `BRIDGE_KIMI_MODEL`, `BRIDGE_KIMI_THINKING`, etc. | Optional |
| Gemini classifier | `BRIDGE_CLAUDE_GEMINI_*` | Optional, disabled by default |
| Access control | `BRIDGE_ALLOWED_CHANNELS`, `BRIDGE_ALLOWED_USERS` | Optional |

### Tests

```bash
npm test
```

Uses Node.js built-in test runner (`node --test`). Tests cover Feishu event handling, card payloads, client API calls, and request execution behavior.

### License

MIT

---

## 中文

飞书原生 Bridge，支持 Claude、Codex 及兼容的 CLI/SDK Runner。

从飞书接收消息，经请求队列和审批控制路由，通过 Claude SDK / Codex / Kimi Runner 执行，以富文本或交互卡片回复。

### 环境要求

| 依赖 | 说明 |
|------|------|
| **Node.js >= 22** | 必需。用 `node -v` 检查版本 |
| **npm** | 随 Node.js 安装 |
| **tmux** | `scripts/start-instance.sh` 启动脚本需要 tmux 管理进程 |
| **飞书自建应用** | 需要一个启用了机器人能力的飞书自建应用 |
| **公网 URL / 反向代理** | Bridge 监听 HTTP，需要 nginx、Caddy 等反向代理提供 HTTPS 给飞书回调 |

#### Runner 额外依赖

| Runner | 额外要求 |
|--------|---------|
| `claude-sdk` | 环境中需设置 `ANTHROPIC_API_KEY`（`@anthropic-ai/claude-agent-sdk` 使用） |
| `codex` | 全局安装 `codex` CLI（`npm i -g @anthropic-ai/codex`） |
| `kimi` | 本地安装 `kimi-cli` 二进制文件 |

### 快速开始

```bash
# 1. 克隆并安装依赖
git clone https://github.com/suntanzer/claude-codex-bridge-feishu.git
cd claude-codex-bridge-feishu
npm install

# 2. 从示例创建实例配置
cp .env.example instances/claude.env

# 3. 编辑 instances/claude.env —— 至少填写：
#    FEISHU_APP_ID=cli_xxxxx
#    FEISHU_APP_SECRET=xxxxx
#    BRIDGE_RUNNER=claude-sdk
#    BRIDGE_DEFAULT_CWD=/path/to/your/workdir
#    FEISHU_PUBLIC_BASE_URL=https://your-domain.com

# 4. 启动 Bridge（在 tmux 会话中运行）
./scripts/start-instance.sh claude

# 5. 查看状态
./scripts/status-instance.sh claude

# 6. 停止
./scripts/stop-instance.sh claude
```

### 最小配置

能正常运行的最小配置：

```env
# instances/claude.env

# --- 必填：飞书应用凭据 ---
FEISHU_APP_ID=cli_xxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx

# --- 必填：选择 Runner ---
BRIDGE_RUNNER=claude-sdk

# --- 必填：Runner 工作目录 ---
BRIDGE_DEFAULT_CWD=/home/user/projects

# --- 审批按钮需要：公网 URL ---
FEISHU_PUBLIC_BASE_URL=https://your-domain.com
```

此配置下 Bridge 将：
- 在 `0.0.0.0:8770` 监听，路径 `/feishu/events/default`
- 使用 Claude SDK 作为 Runner（需要环境中有 `ANTHROPIC_API_KEY`）
- 状态存储在 `./data/default/store.json`

### 飞书应用配置

1. 前往[飞书开放平台](https://open.feishu.cn/)创建自建应用
2. 启用**机器人**能力
3. 在**事件订阅**中，设置请求地址为：
   ```
   https://your-domain.com/feishu/events/bridge
   ```
   （必须匹配 `FEISHU_PUBLIC_BASE_URL` + `FEISHU_CALLBACK_PATH`）
4. 订阅以下事件：
   - `im.message.receive_v1` —— 接收消息
   - `p2p_chat_create` ——（可选）检测新建单聊
5. 在**权限管理**中授予：
   - `im:message` —— 收发消息
   - `im:message:send_as_bot` —— 以机器人身份发消息
   - `im:resource` —— 访问消息资源
   - `im:chat` —— 访问会话信息
6. 如使用卡片交互按钮（审批流程），将**卡片交互**回调 URL 配置为同一地址
7. 将 **App ID**、**App Secret**、**Verification Token**、**Encrypt Key** 填入实例配置文件

### 反向代理示例（nginx）

```nginx
server {
    listen 443 ssl;
    server_name your-domain.com;

    ssl_certificate     /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location /feishu/ {
        proxy_pass http://127.0.0.1:8770;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### 多实例运行

可以同时运行多个 Bridge 实例，使用不同的 Runner 或飞书应用：

```bash
# 创建各自的配置文件
cp .env.example instances/claude.env   # Claude SDK runner
cp .env.example instances/codex.env    # Codex runner

# 使用不同的端口和回调路径
# instances/claude.env:
#   FEISHU_CALLBACK_PORT=8770
#   FEISHU_CALLBACK_PATH=/feishu/events/claude
# instances/codex.env:
#   FEISHU_CALLBACK_PORT=8771
#   FEISHU_CALLBACK_PATH=/feishu/events/codex

# 共享配置放在 instances/common.env（可选）

# 启动各实例
./scripts/start-instance.sh claude
./scripts/start-instance.sh codex
```

### 审批机制

AI 编程 Agent 能执行 shell 命令和修改文件。通过聊天 Bridge 无人值守运行时，每个改变状态的工具调用都是潜在风险。Bridge 实现了**三层审批架构**，自动放行安全读取，拦截危险写入，处理中间的灰色地带：

1. **第一层 —— 规则引擎**（`claude-bash-readonly.mjs`）：确定性模式匹配。已知安全命令（`ls`、`cat`、`git log`、`grep` 等）立即自动放行。已知危险命令（`rm`、`git push`、`systemctl restart`、输出重定向等）直接进入人工审批。管道命令逐段分割检查；SSH 远程命令递归分类。
2. **第二层 —— Gemini LLM 分类器**（`gemini-readonly.mjs`，可选，默认关闭）：规则引擎无法判断的命令，由快速/低成本的外部模型（Gemini Flash Lite）给第二意见。使用独立模型而非 Claude 自身，避免 Agent 判断自己的行为。仅在置信度达到阈值时自动放行（默认 100%，最保守）。**出错时绝不自动放行** —— 任何失败都下沉到人工审批。
3. **第三层 —— 飞书人工审批**：交互卡片带 批准/拒绝/跳过 按钮，加文字回复兜底（`1`/`2`/`3` 或 `confirm`/`skip`/`revise`）。10 分钟超时；任何团队成员可响应。

**Claude SDK 与 Codex —— 两种不同机制：**

- **Claude SDK** 有原生 `canUseTool` 回调。SDK 暂停，Bridge 通过三层分类后返回决策。干净且有 API 支持。
- **Codex** 没有权限回调 API。Bridge 通过**在 system prompt 中注入 checkpoint 协议**解决：教 Codex 在任何状态变更操作前输出结构化的 "Checkpoint" 块。Bridge 从 stdout 事件流中检测此模式，在飞书发送审批卡片，人工决策后通过 `codex exec resume` 作为下一轮 prompt 传回。这是一个基于 prompt 的审批协议——跨版本通用，比 stdin 的 yes/no 语义更丰富，且不依赖未文档化的内部 API。

启用 Gemini 分类器：
```env
BRIDGE_CLAUDE_GEMINI_READONLY_ENABLED=true
BRIDGE_CLAUDE_GEMINI_API_KEY=your-gemini-api-key
BRIDGE_CLAUDE_GEMINI_READONLY_THRESHOLD=100
```

完整的设计理由、数据流图、规则列表和折中分析，见 **[docs/APPROVAL_DESIGN.md](docs/APPROVAL_DESIGN.md)**。

### 运维命令

在飞书对话中发送（默认前缀 `!bridge`）：

| 命令 | 说明 |
|------|------|
| `!bridge status` | 显示 Bridge 状态、活跃请求、队列 |
| `!bridge current` | 显示当前运行中的请求详情 |
| `!bridge cancel` | 取消当前活跃请求 |
| `!bridge doctor` | 运行健康诊断 |

### 目录结构

```
src/
  app/           # 主入口、配置、事件处理、请求执行器
  approval/      # 审批存储、服务、UI 构建器
  ops/           # 运维命令（!bridge status 等）
  requests/      # 请求队列和服务
  runner/        # Runner 适配器（Claude SDK、Codex、Kimi 等）
  store/         # JSON 持久化层
  transport/     # 飞书客户端、Webhook 服务器、卡片、路由
  util/          # 日志、文本分块、ID 生成、时间工具
test/            # Node.js 内置测试运行器测试
scripts/         # 实例启停脚本（基于 tmux）
instances/       # 实例配置文件（除示例外已 gitignore）
docs/            # 审计文档和说明
```

### 环境变量参考

完整列表见 [`.env.example`](.env.example)。主要分组：

| 分组 | 变量 | 是否必填 |
|------|------|---------|
| 飞书凭据 | `FEISHU_APP_ID`、`FEISHU_APP_SECRET` | 是 |
| 飞书安全 | `FEISHU_VERIFICATION_TOKEN`、`FEISHU_ENCRYPT_KEY` | 推荐 |
| 回调服务器 | `FEISHU_CALLBACK_PORT`、`FEISHU_CALLBACK_PATH`、`FEISHU_PUBLIC_BASE_URL` | 端口有默认值；URL 审批按钮需要 |
| 消息过滤 | `FEISHU_ALLOWED_CHAT_IDS`、`FEISHU_ALLOWED_OPEN_IDS`、`FEISHU_GROUP_MODE` | 可选 |
| Bridge 运行时 | `BRIDGE_RUNNER`、`BRIDGE_DEFAULT_CWD`、`BRIDGE_DATA_DIR` | Runner 和 CWD 推荐填写 |
| Claude Runner | `BRIDGE_CLAUDE_MODEL`、`BRIDGE_CLAUDE_THINKING_MODE` 等 | 可选 |
| Codex Runner | `BRIDGE_CODEX_BIN`、`BRIDGE_CODEX_MODEL` 等 | 可选 |
| Kimi Runner | `BRIDGE_KIMI_MODEL`、`BRIDGE_KIMI_THINKING` 等 | 可选 |
| Gemini 分类器 | `BRIDGE_CLAUDE_GEMINI_*` | 可选，默认关闭 |
| 访问控制 | `BRIDGE_ALLOWED_CHANNELS`、`BRIDGE_ALLOWED_USERS` | 可选 |

### 测试

```bash
npm test
```

使用 Node.js 内置测试运行器（`node --test`）。测试覆盖飞书事件处理、卡片构建、客户端 API 调用和请求执行行为。

### 许可证

MIT
