import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { RunnerAdapter } from './base.mjs';

function appendPromptArg(args, prompt) {
  args.push('--', prompt);
  return args;
}

export function buildArgs({ prompt, sessionId, model, profile, reasoningEffort, fullAccess, systemPrompt }) {
  const args = ['exec'];
  if (sessionId) {
    args.push('resume', '--json');
    args.push('--skip-git-repo-check');
    if (fullAccess) args.push('--dangerously-bypass-approvals-and-sandbox');
    if (profile) args.push('-p', profile);
    if (model) args.push('-m', model);
    if (reasoningEffort) args.push('-c', `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`);
    if (systemPrompt) args.push('-c', `system_prompt=${JSON.stringify(systemPrompt)}`);
    args.push(sessionId);
    return appendPromptArg(args, prompt);
  }
  args.push('--json', '--skip-git-repo-check');
  if (fullAccess) args.push('--dangerously-bypass-approvals-and-sandbox');
  if (profile) args.push('-p', profile);
  if (model) args.push('-m', model);
  if (reasoningEffort) args.push('-c', `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`);
  if (systemPrompt) args.push('-c', `system_prompt=${JSON.stringify(systemPrompt)}`);
  return appendPromptArg(args, prompt);
}

function extractAgentText(event) {
  const item = event?.item;
  if (!item || item.type !== 'agent_message') return null;
  if (typeof item.text === 'string' && item.text.trim()) return item.text.trim();
  const content = Array.isArray(item.content) ? item.content : [];
  const parts = content.map((part) => (typeof part?.text === 'string' ? part.text : '')).filter(Boolean);
  return parts.length ? parts.join('\n').trim() : null;
}

function buildChildEnv({ homeDir = '' }) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('CODEX_')) {
      delete env[key];
    }
  }
  if (homeDir) {
    env.CODEX_HOME = homeDir;
  }
  env.PATH = `${process.env.HOME || ''}/.npm-global/bin:${process.env.PATH || ''}`;
  return env;
}

export class CodexRunner extends RunnerAdapter {
  constructor({
    runnerBin,
    logger,
    timeoutMs = 60 * 60_000,
    heartbeatIntervalMs = 5 * 60_000,
    model = '',
    profile = '',
    reasoningEffort = '',
    fullAccess = false,
    systemPrompt = '',
    homeDir = '',
  }) {
    super();
    this.runnerBin = runnerBin;
    this.logger = logger;
    this.timeoutMs = timeoutMs;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.model = model;
    this.profile = profile;
    this.reasoningEffort = reasoningEffort;
    this.fullAccess = fullAccess;
    this.systemPrompt = systemPrompt;
    this.homeDir = homeDir;
    this.currentChild = null;
    this.cancelRequested = false;
  }

  async inspect() {
    return {
      idle: !this.currentChild,
      waitingApproval: false,
      sessionId: '',
    };
  }

  async run(ctx, callbacks = {}) {
    if (this.currentChild) {
      throw new Error('codex runner is already busy');
    }
    this.cancelRequested = false;
    const child = spawn(this.runnerBin, buildArgs({
      prompt: ctx.prompt,
      sessionId: ctx.sessionId,
      model: ctx.model || this.model,
      profile: ctx.profile || this.profile,
      reasoningEffort: this.reasoningEffort,
      fullAccess: this.fullAccess,
      systemPrompt: this.systemPrompt,
    }), {
      cwd: ctx.cwd,
      env: buildChildEnv({ homeDir: this.homeDir }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.currentChild = child;

    let sessionId = ctx.sessionId || '';
    let finalText = '';
    const stderr = [];

    const stdoutReader = readline.createInterface({ input: child.stdout });
    stdoutReader.on('line', (line) => {
      if (!line.trim()) return;
      let event;
      try { event = JSON.parse(line); } catch { event = { type: 'raw.stdout', text: line }; }
      if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
        sessionId = event.thread_id;
      }
      const agentText = extractAgentText(event);
      if (agentText) {
        finalText = agentText;
      }
      callbacks.onEvent?.(event, { sessionId, finalText });
    });

    const stderrReader = readline.createInterface({ input: child.stderr });
    stderrReader.on('line', (line) => stderr.push(line));

    return await new Promise((resolve) => {
      const heartbeat = setInterval(() => callbacks.onHeartbeat?.({ sessionId }), this.heartbeatIntervalMs);
      const startedAt = Date.now();
      let timedOut = false;
      const timeoutTicker = setInterval(() => {
        const activeElapsedMs = Date.now() - startedAt;
        if (activeElapsedMs >= this.timeoutMs) {
          timedOut = true;
          try { child.kill('SIGTERM'); } catch {}
        }
      }, 1000);

      child.on('exit', (code, signal) => {
        clearInterval(heartbeat);
        clearInterval(timeoutTicker);
        this.currentChild = null;
        resolve({
          sessionId,
          finalText,
          ok: code === 0 && !timedOut && !this.cancelRequested,
          code,
          signal,
          reason: timedOut ? 'timeout' : (this.cancelRequested ? 'cancelled' : (code === 0 ? 'completed' : 'failed')),
          diagnostics: { stderr },
        });
      });
    });
  }

  async cancel() {
    if (!this.currentChild) return false;
    this.cancelRequested = true;
    try { this.currentChild.kill('SIGTERM'); } catch {}
    return true;
  }
}
