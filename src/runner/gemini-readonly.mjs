const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_MODEL = 'gemini-2.5-flash-lite';
const DEFAULT_THRESHOLD = 100;
const DEFAULT_TIMEOUT_MS = 5_000;

function parsePositiveInt(raw, fallback) {
  const value = Number.parseInt(String(raw || ''), 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function clampProbability(value) {
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function normalizeVerdict(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (value === 'readonly' || value === 'non_readonly' || value === 'uncertain') {
    return value;
  }
  return '';
}

function parseApiKeys() {
  const keys = [];
  const single = String(process.env.BRIDGE_CLAUDE_GEMINI_API_KEY || '').trim();
  if (single) keys.push(single);
  for (const raw of String(process.env.BRIDGE_CLAUDE_GEMINI_API_KEYS || '').split(',')) {
    const value = raw.trim();
    if (value) keys.push(value);
  }
  return [...new Set(keys)];
}

function extractResponseText(payload) {
  const parts = payload?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map((part) => String(part?.text || '')).join('').trim();
}

function parseClassification(text) {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    const probability = clampProbability(Number(parsed?.readonly_probability));
    const verdict = normalizeVerdict(parsed?.verdict);
    const reason = String(parsed?.reason || '').trim();
    if (probability === null || !verdict || !reason) {
      return null;
    }
    return {
      readonlyProbability: probability,
      verdict,
      reason,
    };
  } catch {
    return null;
  }
}

function buildPrompt(command) {
  return [
    'You are a shell safety classifier.',
    'Decide whether the shell command is read-only on the local or remote machine it targets.',
    'Read-only means it only inspects state and does not modify files, processes, services, git refs, package state, container state, or remote host state.',
    'If a command uses ssh, judge the remote command body.',
    'Be conservative. If there is any write, restart, install, fetch, checkout, redirect to file, or similar state change, do not mark it read-only.',
    'Treat commands like git fetch/pull/checkout/reset/rebase/commit/push, package install/remove, service start/stop/restart, kill/pkill, and output redirection to files as non-read-only.',
    'Interpreter commands such as python -c or node -e are only read-only if the code clearly performs inspection only and does not write files, spawn mutating commands, or change state.',
    'Return strict JSON exactly in this shape:',
    '{"readonly_probability":0-100,"verdict":"readonly|non_readonly|uncertain","reason":"short reason"}',
    '',
    'Command:',
    command,
  ].join('\n');
}

export class GeminiReadonlyClassifier {
  constructor({ logger } = {}) {
    this.logger = logger;
    this.enabled = process.env.BRIDGE_CLAUDE_GEMINI_READONLY_ENABLED === 'true';
    this.apiKeys = parseApiKeys();
    this.baseUrl = String(process.env.BRIDGE_CLAUDE_GEMINI_BASE_URL || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
    this.model = String(process.env.BRIDGE_CLAUDE_GEMINI_MODEL || DEFAULT_MODEL).trim();
    this.threshold = parsePositiveInt(process.env.BRIDGE_CLAUDE_GEMINI_READONLY_THRESHOLD, DEFAULT_THRESHOLD);
    this.timeoutMs = parsePositiveInt(process.env.BRIDGE_CLAUDE_GEMINI_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
    this.keyCursor = 0;
  }

  isEnabled() {
    return this.enabled && this.apiKeys.length > 0 && Boolean(this.baseUrl) && Boolean(this.model);
  }

  shouldAutoAllow(result) {
    return Boolean(result)
      && result.verdict === 'readonly'
      && result.readonlyProbability >= this.threshold;
  }

  nextApiKeys() {
    if (this.apiKeys.length === 0) return [];
    const start = this.keyCursor % this.apiKeys.length;
    this.keyCursor = (this.keyCursor + 1) % this.apiKeys.length;
    const ordered = [];
    for (let offset = 0; offset < this.apiKeys.length; offset += 1) {
      ordered.push({
        apiKey: this.apiKeys[(start + offset) % this.apiKeys.length],
        index: start + offset,
      });
    }
    return ordered;
  }

  async classifyWithKey(command, { apiKey, index, total }) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(
        `${this.baseUrl}/models/${encodeURIComponent(this.model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            contents: [{ parts: [{ text: buildPrompt(command) }] }],
            generationConfig: {
              temperature: 0,
              responseMimeType: 'application/json',
            },
          }),
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        const body = await response.text();
        this.logger?.warn?.(
          `gemini readonly classifier key=${(index % total) + 1}/${total} http=${response.status} body=${body.slice(0, 300)}`,
        );
        return null;
      }

      const payload = await response.json();
      const text = extractResponseText(payload);
      const parsed = parseClassification(text);
      if (!parsed) {
        this.logger?.warn?.(
          `gemini readonly classifier key=${(index % total) + 1}/${total} invalid payload=${text.slice(0, 300)}`,
        );
        return null;
      }
      return parsed;
    } catch (error) {
      this.logger?.warn?.(`gemini readonly classifier key=${(index % total) + 1}/${total} failed: ${String(error)}`);
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  async classifyCommand(command) {
    if (!this.isEnabled()) {
      return null;
    }
    const keys = this.nextApiKeys();
    for (const candidate of keys) {
      const result = await this.classifyWithKey(command, {
        ...candidate,
        total: this.apiKeys.length,
      });
      if (result) {
        return result;
      }
    }
    return null;
  }
}
