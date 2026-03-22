import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { RunnerAdapter } from './base.mjs';
import { classifyReadOnlyBashInput } from './claude-bash-readonly.mjs';
import { GeminiReadonlyClassifier } from './gemini-readonly.mjs';

function toolNameOf(tool) {
  if (typeof tool === 'string') return tool;
  if (tool && typeof tool === 'object' && !Array.isArray(tool) && typeof tool.name === 'string') {
    return tool.name;
  }
  return '';
}

export class ClaudeSdkRunner extends RunnerAdapter {
  constructor({
    logger,
    timeoutMs = 60 * 60_000,
    heartbeatIntervalMs = 5 * 60_000,
    model = '',
    systemPrompt = '',
    thinkingMode = '',
    thinkingBudgetTokens = 0,
    effort = '',
    permissionMode = 'default',
    allowedTools = [],
    disallowedTools = [],
  }) {
    super();
    this.logger = logger;
    this.timeoutMs = timeoutMs;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.model = model;
    this.systemPrompt = systemPrompt;
    this.thinkingMode = thinkingMode;
    this.thinkingBudgetTokens = thinkingBudgetTokens;
    this.effort = effort;
    this.permissionMode = permissionMode;
    this.allowedTools = allowedTools;
    this.disallowedTools = disallowedTools;
    this.currentAbortController = null;
    this.cancelRequested = false;
    this.waitingApproval = false;
    this.currentSessionId = '';
    this.geminiReadonlyClassifier = new GeminiReadonlyClassifier({
      logger: this.logger?.child?.('gemini') || this.logger,
    });
  }

  async inspect() {
    return {
      idle: !this.currentAbortController,
      waitingApproval: this.waitingApproval,
      sessionId: this.currentSessionId,
    };
  }

  buildThinkingConfig() {
    switch (this.thinkingMode) {
      case 'adaptive':
        return { type: 'adaptive' };
      case 'disabled':
        return { type: 'disabled' };
      case 'enabled':
        return this.thinkingBudgetTokens > 0
          ? { type: 'enabled', budgetTokens: this.thinkingBudgetTokens }
          : { type: 'enabled' };
      default:
        return undefined;
    }
  }

  async run(ctx, callbacks = {}) {
    if (this.currentAbortController) {
      throw new Error('claude-sdk runner is already busy');
    }
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const abortController = new AbortController();
    this.currentAbortController = abortController;
    this.cancelRequested = false;
    this.waitingApproval = false;
    let sessionId = ctx.sessionId || '';
    this.currentSessionId = sessionId;
    let finalText = '';
    let waitingApproval = false;
    let approvalPauseMs = 0;
    let approvalStartedAt = 0;
    let timedOut = false;
    const thinking = this.buildThinkingConfig();
    const settingsFile = ctx.cwd ? join(ctx.cwd, '.claude', 'settings.json') : '';
    const claudeSettings = settingsFile && existsSync(settingsFile) ? settingsFile : undefined;

    const stream = query({
      prompt: ctx.prompt,
      options: {
        cwd: ctx.cwd,
        model: ctx.model || this.model || undefined,
        resume: ctx.sessionId || undefined,
        systemPrompt: this.systemPrompt || undefined,
        thinking,
        effort: this.effort || undefined,
        permissionMode: this.permissionMode || 'default',
        settings: claudeSettings,
        allowedTools: this.allowedTools,
        disallowedTools: this.disallowedTools,
        abortController,
        canUseTool: async (tool, input, options = {}) => {
          const toolName = toolNameOf(tool);
          const updatedInput = (input && typeof input === 'object' && !Array.isArray(input))
            ? input
            : {};
          if (toolName === 'Bash') {
            const bashClassification = classifyReadOnlyBashInput(updatedInput);
            if (bashClassification.verdict === 'allow') {
              this.logger?.info?.(`claude auto-approved readonly bash: ${updatedInput.command || '(empty command)'}`);
              return {
                behavior: 'allow',
                updatedInput,
              };
            }
            if (bashClassification.verdict === 'unknown') {
              const geminiResult = await this.geminiReadonlyClassifier.classifyCommand(bashClassification.command);
              if (this.geminiReadonlyClassifier.shouldAutoAllow(geminiResult)) {
                this.logger?.info?.(
                  `claude auto-approved gemini readonly bash: probability=${geminiResult.readonlyProbability} command=${bashClassification.command}`,
                );
                return {
                  behavior: 'allow',
                  updatedInput,
                };
              }
              if (geminiResult) {
                this.logger?.info?.(
                  `claude gemini readonly fallback kept approval: probability=${geminiResult.readonlyProbability} verdict=${geminiResult.verdict} command=${bashClassification.command}`,
                );
              }
            }
          }
          waitingApproval = true;
          this.waitingApproval = true;
          approvalStartedAt = Date.now();
          const decision = await callbacks.requestApproval?.({
            sessionId,
            threadKey: ctx.threadKey,
            command: toolName || 'tool',
            description: JSON.stringify(input || {}),
            rawPrompt: '',
          });
          approvalPauseMs += Date.now() - approvalStartedAt;
          approvalStartedAt = 0;
          waitingApproval = false;
          this.waitingApproval = false;
          if (decision === 'approve_once') {
            return {
              behavior: 'allow',
              updatedInput,
            };
          }
          if (decision === 'approve_always') {
            return {
              behavior: 'allow',
              updatedInput,
              ...(Array.isArray(options.suggestions) && options.suggestions.length > 0
                ? { updatedPermissions: options.suggestions }
                : {}),
            };
          }
          return {
            behavior: 'deny',
            message: 'Permission request rejected in Mattermost.',
          };
        },
      },
    });
    const startedAt = Date.now();
    const heartbeat = setInterval(() => {
      callbacks.onHeartbeat?.({ sessionId, waitingApproval, approvalPauseMs });
    }, this.heartbeatIntervalMs);
    const timeoutTicker = setInterval(() => {
      const activeApprovalPauseMs = approvalStartedAt ? (Date.now() - approvalStartedAt) : 0;
      const activeElapsedMs = Date.now() - startedAt - approvalPauseMs - activeApprovalPauseMs;
      if (activeElapsedMs >= this.timeoutMs) {
        timedOut = true;
        try { abortController.abort(); } catch {}
      }
    }, 1000);

    try {
      for await (const message of stream) {
        callbacks.onEvent?.(message, { sessionId, finalText, waitingApproval });
        if (message?.type === 'result') {
          finalText = message.result || finalText;
          sessionId = message.session_id || sessionId;
          this.currentSessionId = sessionId;
        }
      }
      return {
        sessionId,
        finalText,
        ok: !timedOut && !this.cancelRequested,
        code: timedOut || this.cancelRequested ? 1 : 0,
        signal: null,
        reason: timedOut ? 'timeout' : (this.cancelRequested ? 'cancelled' : 'completed'),
        diagnostics: { approvalPauseMs },
      };
    } catch (error) {
      if (timedOut || this.cancelRequested) {
        return {
          sessionId,
          finalText,
          ok: false,
          code: 1,
          signal: null,
          reason: timedOut ? 'timeout' : 'cancelled',
          diagnostics: {
            approvalPauseMs,
            error: String(error?.message || error),
          },
        };
      }
      throw error;
    } finally {
      clearInterval(heartbeat);
      clearInterval(timeoutTicker);
      this.waitingApproval = false;
      this.currentAbortController = null;
    }
  }

  async cancel() {
    if (!this.currentAbortController) return false;
    this.cancelRequested = true;
    this.currentAbortController.abort();
    return true;
  }
}
