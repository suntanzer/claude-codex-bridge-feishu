import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { RunnerAdapter } from './base.mjs';

function buildWireArgs({ cwd, sessionId, model, thinking, yolo, configFile, agentFile }) {
  const args = ['--wire'];
  if (cwd) args.push('--work-dir', cwd);
  if (sessionId) args.push('--session', sessionId);
  if (model) args.push('--model', model);
  if (thinking === true) args.push('--thinking');
  if (thinking === false) args.push('--no-thinking');
  if (yolo) args.push('--yolo');
  if (configFile) args.push('--config-file', configFile);
  if (agentFile) args.push('--agent-file', agentFile);
  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pushCapped(list, value, cap = 200) {
  list.push(value);
  if (list.length > cap) {
    list.shift();
  }
}

function formatError(error) {
  return String(error?.message || error);
}

function buildApprovalDescription(payload = {}) {
  const lines = [];
  if (payload.sender) lines.push(`sender: ${payload.sender}`);
  if (payload.description) lines.push(String(payload.description));
  if (payload.action && payload.action !== payload.description) {
    lines.push(`action: ${payload.action}`);
  }
  const display = Array.isArray(payload.display) ? payload.display : [];
  const displaySummaries = display
    .map((block) => {
      if (!block || typeof block !== 'object') return '';
      if (block.type === 'diff' && typeof block.path === 'string') {
        return `display: diff ${block.path}`;
      }
      if (typeof block.type === 'string') {
        return `display: ${block.type}`;
      }
      return '';
    })
    .filter(Boolean)
    .slice(0, 2);
  lines.push(...displaySummaries);
  return lines.join('\n') || 'tool operation';
}

function classifyMessage(msg) {
  if (msg && msg.id !== undefined && msg.method === undefined) return 'response';
  if (msg && msg.method === 'event') return 'event';
  if (msg && msg.method === 'request' && msg.id !== undefined) return 'request';
  return 'unknown';
}

function buildJsonRpcError(error) {
  if (error && typeof error === 'object' && error.message) {
    return new Error(String(error.message));
  }
  return new Error(formatError(error));
}

export class KimiRunner extends RunnerAdapter {
  constructor({
    runnerBin,
    logger,
    timeoutMs = 60 * 60_000,
    heartbeatIntervalMs = 5 * 60_000,
    model = '',
    thinking = undefined,
    yolo = false,
    configFile = '',
    agentFile = '',
  }) {
    super();
    this.runnerBin = runnerBin;
    this.logger = logger;
    this.timeoutMs = timeoutMs;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.model = model;
    this.thinking = thinking;
    this.yolo = yolo;
    this.configFile = configFile;
    this.agentFile = agentFile;
    this.currentChild = null;
    this.currentRun = null;
    this.cancelRequested = false;
    this.waitingApproval = false;
    this.currentSessionId = '';
  }

  async inspect() {
    return {
      idle: !this.currentChild,
      waitingApproval: this.waitingApproval,
      sessionId: this.currentSessionId,
    };
  }

  _nextId(state) {
    const id = `ccmm-${state.nextId}`;
    state.nextId += 1;
    return id;
  }

  async _send(state, message) {
    if (state.closing) {
      throw new Error('kimi wire run is closing');
    }
    if (!state.child.stdin || state.child.stdin.destroyed || !state.child.stdin.writable) {
      throw new Error('kimi wire stdin is not writable');
    }
    const payload = `${JSON.stringify(message)}\n`;
    await new Promise((resolve, reject) => {
      state.child.stdin.write(payload, 'utf8', (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  async _call(state, method, params) {
    const id = this._nextId(state);
    const promise = new Promise((resolve, reject) => {
      state.pendingCalls.set(id, { resolve, reject, method });
    });
    try {
      await this._send(state, {
        jsonrpc: '2.0',
        method,
        id,
        params,
      });
    } catch (error) {
      const pending = state.pendingCalls.get(id);
      if (pending) {
        state.pendingCalls.delete(id);
        pending.reject(error);
      }
    }
    return promise;
  }

  async _reply(state, id, result) {
    await this._send(state, {
      jsonrpc: '2.0',
      id,
      result,
    });
  }

  async _replyError(state, id, code, message) {
    await this._send(state, {
      jsonrpc: '2.0',
      id,
      error: {
        code,
        message,
      },
    });
  }

  _rejectAllPendingCalls(state, error) {
    if (state.pendingCalls.size === 0) return;
    for (const pending of state.pendingCalls.values()) {
      pending.reject(error);
    }
    state.pendingCalls.clear();
  }

  _resolvePendingCall(state, message) {
    const pending = state.pendingCalls.get(message.id);
    if (!pending) {
      return;
    }
    state.pendingCalls.delete(message.id);
    if (message.error) {
      pending.reject(buildJsonRpcError(message.error));
      return;
    }
    pending.resolve(message.result);
  }

  _emitHeartbeat(callbacks, state) {
    if (!callbacks.onHeartbeat) return;
    Promise.resolve(callbacks.onHeartbeat({
      sessionId: state.sessionId,
      waitingApproval: this.waitingApproval,
    })).catch((error) => {
      this.logger?.warn?.(`kimi heartbeat callback failed: ${formatError(error)}`);
    });
  }

  _handleEvent(state, params) {
    if (!params || typeof params !== 'object') return;
    const eventType = typeof params.type === 'string' ? params.type : '';
    const payload = params.payload && typeof params.payload === 'object' ? params.payload : {};

    switch (eventType) {
      case 'TurnBegin':
        state.accumulatedText = '';
        state.finalText = '';
        break;
      case 'ContentPart':
        if (payload.type === 'text' && typeof payload.text === 'string') {
          state.accumulatedText += payload.text;
          state.finalText = state.accumulatedText;
        }
        break;
      case 'StatusUpdate':
        state.tokenUsage = payload.token_usage || payload.tokenUsage || state.tokenUsage;
        state.contextUsage = payload.context_usage || payload.contextUsage || state.contextUsage;
        break;
      default:
        break;
    }
  }

  async _handleApprovalRequest(state, message) {
    const params = message?.params;
    const payload = params?.payload && typeof params.payload === 'object' ? params.payload : {};
    this.waitingApproval = true;
    state.approvalStartedAt = Date.now();

    try {
      const decision = await state.callbacks.requestApproval?.({
        sessionId: state.sessionId,
        command: payload.action || payload.sender || 'tool',
        description: buildApprovalDescription(payload),
      });
      if (state.closing) {
        return;
      }
      const approvalStartedAt = state.approvalStartedAt;
      if (approvalStartedAt) {
        state.approvalPauseMs += Date.now() - approvalStartedAt;
      }
      state.approvalStartedAt = 0;
      this.waitingApproval = false;

      const response = decision === 'approve_once'
        ? 'approve'
        : decision === 'approve_always'
          ? 'approve_for_session'
          : 'reject';

      await this._reply(state, message.id, {
        request_id: payload.id || message.id,
        response,
      });
    } catch (error) {
      const approvalStartedAt = state.approvalStartedAt;
      if (approvalStartedAt) {
        state.approvalPauseMs += Date.now() - approvalStartedAt;
      }
      state.approvalStartedAt = 0;
      this.waitingApproval = false;
      if (state.closing) {
        return;
      }
      this.logger?.warn?.(`kimi approval request failed: ${formatError(error)}`);
      try {
        await this._reply(state, message.id, {
          request_id: payload.id || message.id,
          response: 'reject',
        });
      } catch {}
    }
  }

  async _handleInboundRequest(state, message) {
    if (!message || typeof message !== 'object') return;
    const params = message.params && typeof message.params === 'object' ? message.params : {};
    const requestType = typeof params.type === 'string' ? params.type : '';

    switch (requestType) {
      case 'ApprovalRequest':
        await this._handleApprovalRequest(state, message);
        return;
      case 'QuestionRequest':
        await this._replyError(state, message.id, -32601, 'question requests are not supported');
        return;
      case 'ToolCallRequest':
        await this._replyError(state, message.id, -32601, 'external tool requests are not supported');
        return;
      default:
        await this._replyError(state, message.id, -32601, `unsupported wire request: ${requestType || 'unknown'}`);
    }
  }

  _requestCancel(state) {
    if (state.closing || state.cancelSent) {
      return;
    }
    state.cancelSent = true;
    Promise.resolve(this._call(state, 'cancel', {})).catch(() => {});
  }

  async run(ctx, callbacks = {}) {
    if (this.currentChild) {
      throw new Error('kimi runner is already busy');
    }

    const sessionId = ctx.sessionId || ctx.threadKey;
    this.cancelRequested = false;
    this.waitingApproval = false;
    this.currentSessionId = sessionId;

    const child = spawn(this.runnerBin, buildWireArgs({
      cwd: ctx.cwd,
      sessionId,
      model: ctx.model || this.model || '',
      thinking: this.thinking,
      yolo: this.yolo,
      configFile: this.configFile,
      agentFile: this.agentFile,
    }), {
      cwd: ctx.cwd,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.currentChild = child;

    const state = {
      child,
      callbacks,
      sessionId,
      nextId: 1,
      pendingCalls: new Map(),
      pendingInboundTasks: new Set(),
      closing: false,
      cancelSent: false,
      accumulatedText: '',
      finalText: '',
      tokenUsage: null,
      contextUsage: null,
      approvalPauseMs: 0,
      approvalStartedAt: 0,
      exitCode: null,
      exitSignal: null,
      childError: null,
    };
    this.currentRun = state;

    const stderr = [];
    const stdoutReader = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    const stderrReader = readline.createInterface({ input: child.stderr, crlfDelay: Infinity });

    stderrReader.on('line', (line) => {
      pushCapped(stderr, line);
    });

    const readLoop = (async () => {
      try {
        for await (const line of stdoutReader) {
          const trimmed = String(line || '').trim();
          if (!trimmed) continue;
          let message;
          try {
            message = JSON.parse(trimmed);
          } catch {
            this.logger?.warn?.(`kimi wire emitted non-JSON stdout line: ${trimmed}`);
            continue;
          }
          const kind = classifyMessage(message);
          if (kind === 'response') {
            this._resolvePendingCall(state, message);
            continue;
          }
          if (kind === 'event') {
            this._handleEvent(state, message.params);
            continue;
          }
          if (kind === 'request') {
            const task = this._handleInboundRequest(state, message).catch((error) => {
              this.logger?.warn?.(`kimi inbound request error: ${formatError(error)}`);
            });
            state.pendingInboundTasks.add(task);
            task.finally(() => {
              state.pendingInboundTasks.delete(task);
            });
            continue;
          }
          this.logger?.warn?.(`kimi wire emitted unknown message shape: ${trimmed}`);
        }
      } catch (error) {
        if (!state.closing) {
          this.logger?.warn?.(`kimi stdout read loop failed: ${formatError(error)}`);
        }
      }
    })();

    const exitPromise = new Promise((resolve) => {
      child.once('exit', (code, signal) => {
        state.exitCode = code;
        state.exitSignal = signal;
        this._rejectAllPendingCalls(
          state,
          new Error(`kimi wire exited: code=${code ?? 'null'} signal=${signal || 'none'}`),
        );
        resolve();
      });
      child.once('error', (error) => {
        state.childError = error;
        this._rejectAllPendingCalls(state, error);
      });
    });

    const startedAt = Date.now();
    let timedOut = false;

    const heartbeat = setInterval(() => {
      this._emitHeartbeat(callbacks, state);
    }, this.heartbeatIntervalMs);

    const timeoutTicker = setInterval(() => {
      const activeApprovalPauseMs = state.approvalStartedAt ? (Date.now() - state.approvalStartedAt) : 0;
      const activeElapsedMs = Date.now() - startedAt - state.approvalPauseMs - activeApprovalPauseMs;
      if (!timedOut && activeElapsedMs >= this.timeoutMs) {
        timedOut = true;
        this._requestCancel(state);
        setTimeout(() => {
          try { state.child.kill('SIGTERM'); } catch {}
        }, 3000);
      }
    }, 1000);

    try {
      await this._call(state, 'initialize', {
        protocol_version: '1.5',
        client: { name: 'ccmm', version: '1.0' },
        capabilities: {
          supports_question: false,
          supports_plan_mode: false,
        },
        external_tools: [],
      });

      const promptResult = await this._call(state, 'prompt', {
        user_input: ctx.prompt,
      });

      const promptStatus = String(promptResult?.status || '');
      const ok = promptStatus === 'finished' && !timedOut && !this.cancelRequested;
      const reason = timedOut
        ? 'timeout'
        : (this.cancelRequested || promptStatus === 'cancelled')
          ? 'cancelled'
          : promptStatus === 'max_steps_reached'
            ? 'max_steps_reached'
            : ok
              ? 'completed'
              : 'failed';

      return {
        sessionId,
        finalText: state.finalText.trim(),
        ok,
        code: ok ? 0 : 1,
        signal: null,
        reason,
        diagnostics: {
          stderr,
          tokenUsage: state.tokenUsage,
          contextUsage: state.contextUsage,
          approvalPauseMs: state.approvalPauseMs,
        },
      };
    } catch (error) {
      return {
        sessionId,
        finalText: state.finalText.trim(),
        ok: false,
        code: 1,
        signal: state.exitSignal,
        reason: timedOut ? 'timeout' : (this.cancelRequested ? 'cancelled' : 'failed'),
        diagnostics: {
          stderr,
          tokenUsage: state.tokenUsage,
          contextUsage: state.contextUsage,
          approvalPauseMs: state.approvalPauseMs,
          error: formatError(error),
        },
      };
    } finally {
      clearInterval(heartbeat);
      clearInterval(timeoutTicker);
      state.closing = true;
      this.waitingApproval = false;
      state.approvalStartedAt = 0;
      this._rejectAllPendingCalls(state, new Error('kimi wire run closed'));
      try { child.stdin?.end(); } catch {}
      try { child.kill('SIGTERM'); } catch {}
      await Promise.race([exitPromise, sleep(1000)]);
      await Promise.race([readLoop, sleep(500)]);
      if (state.pendingInboundTasks.size > 0) {
        await Promise.race([
          Promise.allSettled([...state.pendingInboundTasks]),
          sleep(250),
        ]);
      }
      stdoutReader.close();
      stderrReader.close();
      this.currentChild = null;
      this.currentRun = null;
      this.currentSessionId = '';
    }
  }

  async cancel() {
    if (!this.currentChild || !this.currentRun) return false;
    this.cancelRequested = true;
    this._requestCancel(this.currentRun);
    setTimeout(() => {
      try { this.currentChild?.kill('SIGTERM'); } catch {}
    }, 3000);
    return true;
  }
}
