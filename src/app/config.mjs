import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..', '..');

function parseList(raw) {
  return String(raw || '').split(',').map((v) => v.trim()).filter(Boolean);
}

function parsePositiveInt(raw, fallback) {
  const value = Number.parseInt(String(raw || ''), 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizePath(raw, fallback) {
  const value = String(raw || fallback || '').trim();
  if (!value) return fallback;
  return value.startsWith('/') ? value.replace(/\/+$/, '') : `/${value.replace(/\/+$/, '')}`;
}

function normalizeRunner(raw) {
  const runner = String(raw || '').trim().toLowerCase();
  if (['kimi', 'codex', 'claude-sdk', 'codex-tmux', 'claude-tmux'].includes(runner)) {
    return runner;
  }
  throw new Error(`Unsupported runner: ${raw}`);
}

function normalizeInstanceName(raw) {
  const value = String(raw || 'default').trim().toLowerCase();
  if (!value) return 'default';
  const normalized = value.replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || 'default';
}

function normalizeGroupMode(raw) {
  const value = String(raw || 'mention_only').trim().toLowerCase();
  if (['mention_only', 'all_messages'].includes(value)) {
    return value;
  }
  throw new Error(`Unsupported Feishu group mode: ${raw}`);
}

async function loadScopedAgentsInstructions(cwd) {
  const agentsPath = join(cwd, 'AGENTS.md');
  if (!existsSync(agentsPath)) return '';
  try {
    return (await readFile(agentsPath, 'utf8')).trim();
  } catch {
    return '';
  }
}

export async function loadConfig() {
  const instanceName = normalizeInstanceName(process.env.CCMM_INSTANCE || process.env.BRIDGE_INSTANCE || 'default');
  const bridgeRunner = normalizeRunner(process.env.BRIDGE_RUNNER || 'codex');
  const defaultRunnerBin = bridgeRunner === 'kimi'
    ? join(homedir(), 'tools', 'kimi-cli', 'bin', 'kimi-isolated')
    : join(homedir(), '.npm-global', 'bin', 'codex');
  const defaultCwd = resolve(process.env.BRIDGE_DEFAULT_CWD || projectRoot);
  const dataDir = resolve(process.env.BRIDGE_DATA_DIR || join(projectRoot, 'data', instanceName));
  await mkdir(dataDir, { recursive: true });

  const codexBin = resolve(process.env.BRIDGE_CODEX_BIN || join(homedir(), '.npm-global', 'bin', 'codex'));
  const codexSystemPromptFile = process.env.BRIDGE_CODEX_SYSTEM_PROMPT_FILE
    ? resolve(process.env.BRIDGE_CODEX_SYSTEM_PROMPT_FILE)
    : '';
  let codexSystemPrompt = (process.env.BRIDGE_CODEX_SYSTEM_PROMPT || '').trim();
  if (!codexSystemPrompt && codexSystemPromptFile && existsSync(codexSystemPromptFile)) {
    codexSystemPrompt = (await readFile(codexSystemPromptFile, 'utf8')).trim();
  }

  const claudeSystemPromptFile = process.env.BRIDGE_CLAUDE_SYSTEM_PROMPT_FILE
    ? resolve(process.env.BRIDGE_CLAUDE_SYSTEM_PROMPT_FILE)
    : '';
  let claudeSystemPrompt = (process.env.BRIDGE_CLAUDE_SYSTEM_PROMPT || '').trim();
  if (!claudeSystemPrompt && claudeSystemPromptFile && existsSync(claudeSystemPromptFile)) {
    claudeSystemPrompt = (await readFile(claudeSystemPromptFile, 'utf8')).trim();
  }
  if (!claudeSystemPrompt) {
    claudeSystemPrompt = await loadScopedAgentsInstructions(defaultCwd);
  }

  const cfg = {
    projectRoot,
    instanceName,
    dataDir,
    commandPrefix: (process.env.BRIDGE_COMMAND_PREFIX || '!bridge').trim(),
    defaultCwd,
    bridgeRunner,
    runnerBin: resolve(process.env.BRIDGE_RUNNER_BIN || defaultRunnerBin),
    runnerShareDir: process.env.BRIDGE_RUNNER_SHARE_DIR ? resolve(process.env.BRIDGE_RUNNER_SHARE_DIR) : '',

    feishuAppId: (process.env.FEISHU_APP_ID || '').trim(),
    feishuAppSecret: (process.env.FEISHU_APP_SECRET || '').trim(),
    feishuVerificationToken: (process.env.FEISHU_VERIFICATION_TOKEN || '').trim(),
    feishuEncryptKey: (process.env.FEISHU_ENCRYPT_KEY || '').trim(),
    feishuCallbackPort: parsePositiveInt(process.env.FEISHU_CALLBACK_PORT, 8770),
    feishuCallbackListenHost: (process.env.FEISHU_CALLBACK_LISTEN_HOST || '0.0.0.0').trim(),
    feishuCallbackPath: normalizePath(process.env.FEISHU_CALLBACK_PATH, `/feishu/events/${instanceName}`),
    feishuPublicBaseUrl: String(process.env.FEISHU_PUBLIC_BASE_URL || '').trim().replace(/\/+$/, ''),
    feishuAllowedChatIds: parseList(process.env.FEISHU_ALLOWED_CHAT_IDS),
    feishuAllowedOpenIds: parseList(process.env.FEISHU_ALLOWED_OPEN_IDS),
    feishuGroupMode: normalizeGroupMode(process.env.FEISHU_GROUP_MODE || 'mention_only'),
    feishuSendWelcomeOnP2pEnter: process.env.FEISHU_SEND_WELCOME_ON_P2P_ENTER === 'true',

    allowedChannels: parseList(process.env.BRIDGE_ALLOWED_CHANNELS),
    allowedUsers: parseList(process.env.BRIDGE_ALLOWED_USERS),

    kimiModel: (process.env.BRIDGE_KIMI_MODEL || '').trim(),
    kimiThinking: process.env.BRIDGE_KIMI_THINKING === 'true'
      ? true
      : process.env.BRIDGE_KIMI_THINKING === 'false'
        ? false
        : undefined,
    kimiYolo: process.env.BRIDGE_KIMI_YOLO === 'true',
    kimiConfigFile: process.env.BRIDGE_KIMI_CONFIG_FILE ? resolve(process.env.BRIDGE_KIMI_CONFIG_FILE) : '',
    kimiAgentFile: process.env.BRIDGE_KIMI_AGENT_FILE ? resolve(process.env.BRIDGE_KIMI_AGENT_FILE) : '',

    codexBin,
    codexModel: (process.env.BRIDGE_CODEX_MODEL || '').trim(),
    codexProfile: (process.env.BRIDGE_CODEX_PROFILE || '').trim(),
    codexReasoningEffort: (process.env.BRIDGE_CODEX_REASONING_EFFORT || '').trim(),
    codexFullAccess: process.env.BRIDGE_CODEX_FULL_ACCESS === 'true',
    codexSystemPromptFile,
    codexSystemPrompt,
    codexHomeDir: resolve(process.env.BRIDGE_CODEX_HOME_DIR || join(projectRoot, '.codex')),

    claudeSystemPromptFile,
    claudeSystemPrompt,
    claudeModel: (process.env.BRIDGE_CLAUDE_MODEL || '').trim(),
    claudeThinkingMode: (process.env.BRIDGE_CLAUDE_THINKING_MODE || '').trim(),
    claudeThinkingBudgetTokens: parsePositiveInt(process.env.BRIDGE_CLAUDE_THINKING_BUDGET_TOKENS, 0),
    claudeEffort: (process.env.BRIDGE_CLAUDE_EFFORT || '').trim(),
    claudePermissionMode: (process.env.BRIDGE_CLAUDE_PERMISSION_MODE || 'default').trim(),
    claudeAllowedTools: parseList(process.env.BRIDGE_CLAUDE_ALLOWED_TOOLS),
    claudeDisallowedTools: parseList(process.env.BRIDGE_CLAUDE_DISALLOWED_TOOLS),
    claudeProjectsDir: resolve(process.env.BRIDGE_CLAUDE_PROJECTS_DIR || join(homedir(), '.claude', 'projects')),

    tmuxSessionName: (process.env.BRIDGE_TMUX_SESSION || 'cc').trim(),
    runnerTimeoutMs: parsePositiveInt(process.env.BRIDGE_RUNNER_TIMEOUT_MINS, 60) * 60_000,
    heartbeatIntervalMs:
      (process.env.BRIDGE_HEARTBEAT_INTERVAL_SECS
        ? parsePositiveInt(process.env.BRIDGE_HEARTBEAT_INTERVAL_SECS, 30) * 1000
        : parsePositiveInt(process.env.BRIDGE_HEARTBEAT_INTERVAL_MINS, 5) * 60_000),
    typingIntervalMs: parsePositiveInt(process.env.BRIDGE_TYPING_INTERVAL_SECS, 3) * 1000,
    progressMessageMs: parsePositiveInt(process.env.BRIDGE_PROGRESS_MESSAGE_SECS, 300) * 1000,
    requestRetainDays: parsePositiveInt(process.env.BRIDGE_REQUEST_RETAIN_DAYS, 7),
    inboundFileMaxCount: parsePositiveInt(process.env.BRIDGE_INBOUND_FILE_MAX_COUNT, 5),
    inboundFileMaxBytes: parsePositiveInt(process.env.BRIDGE_INBOUND_FILE_MAX_BYTES, 8 * 1024 * 1024),
    inboundInlineTextBytes: parsePositiveInt(process.env.BRIDGE_INBOUND_INLINE_TEXT_BYTES, 32 * 1024),

    storeFile: join(dataDir, 'store.json'),
  };

  if (!cfg.feishuAppId) {
    throw new Error('FEISHU_APP_ID is missing.');
  }
  if (!cfg.feishuAppSecret) {
    throw new Error('FEISHU_APP_SECRET is missing.');
  }

  return cfg;
}
