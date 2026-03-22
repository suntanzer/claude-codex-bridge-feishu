# Audit Findings / 审计发现

Audit date: 2026-03-22
Audited commit: `8b4d046` (main branch)

This document records all findings from the code audit for future remediation.
本文档记录代码审计的所有发现，供后续修复参考。

---

## HIGH — Must Fix / 高优先级 — 必须修复

### H1. Webhook verification token can be bypassed / Webhook 验证 token 可被绕过

**File:** `src/transport/feishu-webhook-server.mjs` line 63

```js
if (verificationToken && token && token !== verificationToken)
```

The triple AND condition means:
- If `FEISHU_VERIFICATION_TOKEN` is not set, all requests pass through with no authentication
- Even if set, an attacker can send a payload without a `token` field to bypass verification (falsy `token` short-circuits)

三重 AND 条件意味着：
- 若未设 `FEISHU_VERIFICATION_TOKEN`，所有请求直接通过
- 即使已设置，攻击者发送不含 `token` 字段的 payload 即可绕过

**Fix:** Change to: if token is configured, it must be present and match; otherwise reject.

### H2. `find -exec` bypasses readonly auto-approval / `find -exec` 绕过只读自动审批

**File:** `src/runner/claude-bash-readonly.mjs` line 32

```js
/^find\b/i   // allows all find commands
```

`BLOCKED_PATTERNS` only match command-initial patterns like `rm`, `chmod`, etc. They do not catch `find -exec rm -rf {} \;`, `find -delete`, or `find -execdir` — these would be **auto-approved**.

`BLOCKED_PATTERNS` 仅匹配命令开头的 `rm`/`chmod` 等，不能拦截 `find -exec rm -rf {} \;`、`find -delete` 等危险命令，这些会被自动放行。

**Fix:** Add blocked patterns for `-exec`, `-delete`, `-execdir` within find commands.

### H3. `json-store.mjs` save chain breaks permanently on failure / 保存链故障后永久静默失败

**File:** `src/store/json-store.mjs` line 44

```js
this._saveChain = this._saveChain.then(() => this._doSave());
```

If any `_doSave()` fails (disk full, permission error, etc.), the Promise chain stays permanently rejected. All subsequent `save()` calls silently fail — the bridge continues running but loses all persistence. On restart, all approval/request state is lost.

若任何一次 `_doSave()` 失败，Promise chain 永久 rejected，后续所有 `save()` 调用静默失败。Bridge 继续运行但丧失持久化能力。

**Fix:** Add `.catch()` to reset the chain, or switch to an independent write lock.

### H4. `runNextRequest` has TOCTOU race condition / TOCTOU 竞态条件

**File:** `src/app/request-executor.mjs` lines 125-135

Concurrent webhooks can trigger two interleaved `runNextRequest` calls. The first acquires the runner, but before marking it as running, the second also enters the critical section, hits the runner's "already busy" guard, and incorrectly marks the request as failed.

并发 webhook 可触发两个交错的 `runNextRequest` 调用。第一个拿到 runner 后、标记 running 前，第二个也进入，导致请求被错误标记为 failed。

**Fix:** Add a mutex or busy flag check before entering the runner execution path.

---

## MEDIUM — Should Fix / 中优先级 — 应该修复

### M1. No HMAC signature verification / 无 HMAC 签名验证

**File:** `src/transport/feishu-webhook-server.mjs`

The webhook server does not verify `X-Lark-Signature` headers. It only relies on the weaker body-embedded `token` field (which itself has the H1 bypass issue).

未校验 `X-Lark-Signature` 头。仅依赖更弱的 body 内 token 字段。

### M2. `config.typingIntervalMs` is undefined / `typingIntervalMs` 未定义

**Files:** `src/app/request-executor.mjs` line 163, `src/app/config.mjs`

`setInterval(fn, undefined)` fires at ~4ms intervals (Node.js treats `undefined` as `0`), causing excessive CPU usage for the typing indicator loop.

`setInterval(fn, undefined)` 以 ~4ms 极速触发，造成不必要的 CPU 消耗。

**Fix:** Add `typingIntervalMs` to config, or use `heartbeatIntervalMs` as fallback.

### M3. Feishu token 401 no refresh / 飞书 token 401 不刷新

**File:** `src/transport/feishu-client.mjs` lines 63-78

`getAccessToken()` caches the token but has no 401 retry or token-expiry detection logic. If the token expires mid-session, all API calls fail until the bridge is restarted.

token 缓存后无 401 重试或过期检测逻辑。token 过期后所有 API 调用失败，直到重启。

### M4. Token refresh race condition / Token 刷新竞态

**File:** `src/transport/feishu-client.mjs` lines 38-61

Concurrent requests can trigger multiple simultaneous token exchanges.

并发请求可同时触发多次 token exchange。

### M5. Any channel user can approve/reject / 任何频道用户都能审批

**File:** `src/app/feishu-event-handler.mjs` lines 80-96

Approval card button clicks are not checked against the original requester's identity. Any user in the chat can approve or reject.

审批卡片按钮点击未校验发起者身份，任何群成员都能审批或拒绝。

### M6. `>()` process substitution not blocked / 进程替换未拦截

**File:** `src/runner/claude-bash-readonly.mjs` line 30

The readonly checker blocks `>` redirect but misses `>()` process substitution, which can write to arbitrary files.

只读检查阻止了 `>` 但遗漏了 `>()` 进程替换。

### M7. Gemini classifier vulnerable to prompt injection / Gemini 分类器可被 prompt injection

**File:** `src/runner/gemini-readonly.mjs` lines 61-76

Raw command text is directly interpolated into the Gemini prompt. A crafted command could manipulate the classification result.

原始命令直接拼入 Gemini prompt，恶意命令可操纵分类结果。

### M8. Gemini API key in URL query parameter / API key 在 URL 参数中

**File:** `src/runner/gemini-readonly.mjs` line 119

The API key is passed as a URL query parameter (`?key=...`), which may be logged by proxies, load balancers, or access logs.

API key 作为 URL 参数传递，可能被代理、负载均衡器或访问日志记录。

### M9. `onEvent` callback not awaited / 回调未 await

**Files:** `src/runner/claude-sdk.mjs` line 190, `src/runner/codex.mjs` line 127

Async callbacks that throw become unhandled Promise rejections instead of being caught.

异步回调抛错变成 unhandled rejection。

### M10. No webhook event deduplication / 无 webhook 事件去重

**File:** `src/transport/feishu-webhook-server.mjs`

Feishu retries failed deliveries. Without tracking `event_id`, duplicate events cause duplicate request enqueuing.

飞书重发失败事件，无 `event_id` 追踪导致重复入队。

### M11. KimiRunner cancel race condition / Kimi 取消竞态

**File:** `src/runner/kimi.mjs` lines 523-531

The 3-second delayed kill after cancel may kill the next `run()` invocation's process if it starts within that window.

取消后 3 秒延迟 kill 可能杀掉下一次 `run()` 的进程。

---

## LOW / Informational / 低优先级 / 信息性

| # | Finding / 发现 | File / 文件 |
|---|----------------|-------------|
| L1 | No replay protection (event_id not tracked) / 无重放防护 | `feishu-webhook-server.mjs` |
| L2 | Feishu error response body leaks into exception messages / 错误响应体泄露到异常信息 | `feishu-client.mjs:54` |
| L3 | Auto-approved command full text logged / 自动审批命令全文记录到日志 | `claude-sdk.mjs:115` |
| L4 | User messages persisted to disk store.json (7-day default) / 用户消息持久化到磁盘 | `requests/service.mjs:30` |
| L5 | Malformed JSON returns 500 instead of 400 / 畸形 JSON 返回 500 | `feishu-webhook-server.mjs:49` |
| L6 | No 429/5xx retry mechanism for Feishu API / 无重试机制 | `feishu-client.mjs` |
| L7 | Orphan `.tmp` files left on write failure / 写入失败后孤儿临时文件 | `json-store.mjs` |

---

## Dead Code / 死代码

These files are completely unreachable from the runtime entry point (`src/app/main.mjs`):
以下文件从运行时入口完全不可达：

| File / 文件 | Description / 说明 |
|-------------|-------------------|
| `src/transport/mattermost-client.mjs` | Full Mattermost REST+WS client, zero imports / 完整 MM 客户端，零引用 |
| `src/transport/routing.mjs` | Only imported by dead `post-handler.mjs` / 仅被死代码引用 |
| `src/transport/rich-post.mjs` | Mattermost-style post processing, zero imports / MM 风格 post 处理 |
| `src/runner/tmux-common.mjs` | tmux utility functions, zero imports / tmux 工具函数 |
| `src/app/post-handler.mjs` | Mattermost post handler, only imported in tests / 仅测试引用 |
| `src/app/interaction-server.mjs` | Mattermost interaction server, only imported in tests / 仅测试引用 |

Additionally / 另外:
- `src/runner/codex-tmux.mjs` and `src/runner/claude-tmux.mjs` are wired stubs that only throw "deprecated" errors / 仅抛出 "deprecated" 错误的桩
- `src/approval/ui.mjs` exports `buildApprovalProps()` which is Mattermost-specific dead code / 导出了 MM 专用的死代码
- `src/ops/commands.mjs` returns Mattermost-style `attachments` silently ignored by Feishu `postMessage` / 返回的 MM 风格附件被飞书发送路径静默忽略

### Mattermost string leak in Feishu runtime / 飞书运行时中的 Mattermost 字符串

- `src/runner/claude-sdk.mjs` line 170: `'Permission request rejected in Mattermost.'` — user-visible text that says "Mattermost" in a Feishu context / 用户可见文本中写着 "Mattermost"

---

## Code Duplication / 代码重复

| Duplicated function / 重复函数 | Locations / 位置 |
|-------------------------------|------------------|
| `parseCommand()` | `src/transport/routing.mjs:19-27` and `src/app/feishu-event-handler.mjs:8-16` |
| `normalizeInstanceName()` | `src/app/config.mjs:33-38` and `src/app/instance-env.mjs:9-13` (different defaults) |
| `parsePositiveInt()` | `src/app/config.mjs:14-17` and `src/runner/gemini-readonly.mjs:6-9` |
| `buildFields()` | `src/ops/commands.mjs:14-19` and `src/ops/doctor.mjs:23-29` |

---

## Test Coverage Gaps / 测试覆盖缺失

| Untested module / 未测试模块 | Risk / 风险 |
|-----------------------------|-------------|
| `claude-bash-readonly.mjs` (220 lines of security-critical code) | **Highest** — determines which commands are auto-approved / 决定哪些命令自动放行 |
| `feishu-signature.mjs` (AES decryption) | High — security-critical path / 安全关键路径 |
| All Runner `run()` methods | High |
| `json-store.mjs` persistence | Medium |
| `RequestQueue` / `RequestService` | Medium |
| `ApprovalService` lifecycle | Medium |
| `config.mjs` env var parsing | Low |

Note: `approval-resolution-consistency.test.mjs` (2 tests) exercises dead Mattermost code paths, not the live Feishu runtime.
注意：`approval-resolution-consistency.test.mjs` 的 2 个测试实际测的是 Mattermost 死代码路径。

---

## Package Metadata / 包元数据

`package.json` is missing for a public repository:
公开仓库的 `package.json` 缺少：

- `license` field → added "MIT"
- `repository` field → added
- `author` field → added
- `private: true` → added (prevent accidental npm publish)

---

## Git Metadata / Git 元数据

The initial commit author email contains a VPS hostname:
初始提交的 author email 包含 VPS 主机名：

```
8b4d046 Jet Rocket <jetR@v2202601327998423670.happysrv.de>
```

This is permanently visible in git history on GitHub. Consider rewriting history before wider sharing.
此信息在 GitHub git 历史中永久可见。建议在更广泛分享前重写历史。
