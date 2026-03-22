import { KimiRunner } from './kimi.mjs';
import { CodexRunner } from './codex.mjs';
import { ClaudeSdkRunner } from './claude-sdk.mjs';
import { CodexTmuxRunner } from './codex-tmux.mjs';
import { ClaudeTmuxRunner } from './claude-tmux.mjs';

export function runnerLabel(runner) {
  switch (runner) {
    case 'kimi':
      return 'Kimi Code';
    case 'codex':
      return 'Codex';
    case 'claude-sdk':
      return 'Claude SDK';
    case 'codex-tmux':
      return 'Codex tmux';
    case 'claude-tmux':
      return 'Claude tmux';
    default:
      return runner;
  }
}

export function createRunner(config, logger) {
  const base = {
    logger,
    timeoutMs: config.runnerTimeoutMs,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
  };

  switch (config.bridgeRunner) {
    case 'kimi':
      return new KimiRunner({
        ...base,
        runnerBin: config.runnerBin,
        model: config.kimiModel,
        thinking: config.kimiThinking,
        yolo: config.kimiYolo,
        configFile: config.kimiConfigFile,
        agentFile: config.kimiAgentFile,
      });
    case 'codex':
      return new CodexRunner({
        ...base,
        runnerBin: config.codexBin || config.runnerBin,
        model: config.codexModel,
        profile: config.codexProfile,
        reasoningEffort: config.codexReasoningEffort,
        fullAccess: config.codexFullAccess,
        systemPrompt: config.codexSystemPrompt,
        homeDir: config.codexHomeDir,
      });
    case 'claude-sdk':
      return new ClaudeSdkRunner({
        ...base,
        model: config.claudeModel,
        systemPrompt: config.claudeSystemPrompt,
        thinkingMode: config.claudeThinkingMode,
        thinkingBudgetTokens: config.claudeThinkingBudgetTokens,
        effort: config.claudeEffort,
        permissionMode: config.claudePermissionMode,
        allowedTools: config.claudeAllowedTools,
        disallowedTools: config.claudeDisallowedTools,
      });
    case 'codex-tmux':
      return new CodexTmuxRunner({
        logger,
        tmuxSessionName: config.tmuxSessionName,
      });
    case 'claude-tmux':
      return new ClaudeTmuxRunner({
        logger,
        tmuxSessionName: config.tmuxSessionName,
      });
    default:
      throw new Error(`Unsupported runner: ${config.bridgeRunner}`);
  }
}
