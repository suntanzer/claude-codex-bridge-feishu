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

When the runner requests permission to execute a tool (e.g. Bash command, file write):

1. **Rule-based auto-approval** — clearly readonly Bash commands (e.g. `ls`, `cat`, `git status`) are auto-approved
2. **Gemini classifier** (optional) — uncertain commands can be classified by Gemini as readonly; disabled by default
3. **Manual approval** — everything else shows an interactive card in Feishu with Approve / Reject / Skip buttons

The Gemini classifier is disabled by default. Enable it with:
```env
BRIDGE_CLAUDE_GEMINI_READONLY_ENABLED=true
BRIDGE_CLAUDE_GEMINI_API_KEY=your-gemini-api-key
BRIDGE_CLAUDE_GEMINI_READONLY_THRESHOLD=100
```

A threshold of `100` means only approve if Gemini returns 100% confidence it is readonly (most conservative).

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

当 Runner 请求执行工具（如 Bash 命令、文件写入）时：

1. **规则自动审批** —— 明确只读的 Bash 命令（如 `ls`、`cat`、`git status`）自动通过
2. **Gemini 分类器**（可选）—— 不确定的命令可由 Gemini 判断是否只读；默认关闭
3. **人工审批** —— 其他情况在飞书中显示交互卡片，带有 批准 / 拒绝 / 跳过 按钮

Gemini 分类器默认关闭，启用方式：
```env
BRIDGE_CLAUDE_GEMINI_READONLY_ENABLED=true
BRIDGE_CLAUDE_GEMINI_API_KEY=your-gemini-api-key
BRIDGE_CLAUDE_GEMINI_READONLY_THRESHOLD=100
```

`BRIDGE_CLAUDE_GEMINI_READONLY_THRESHOLD=100` 表示仅当 Gemini 返回 100% 只读置信度时才自动通过（最保守设置）。

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
