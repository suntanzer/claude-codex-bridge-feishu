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

function normalizeBaseUrl(raw, fallback = DEFAULT_BASE_URL) {
  const value = String(raw || fallback || '').trim().replace(/\/+$/, '');
  return value || fallback;
}

function splitCommaSeparated(raw) {
  return String(raw || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function uniqueNonEmpty(values) {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

function uniqueTargets(targets) {
  const seen = new Set();
  const ordered = [];
  for (const target of targets) {
    const signature = `${target.model}\u0000${target.baseUrl}\u0000${target.apiKey}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    ordered.push(target);
  }
  return ordered;
}

function parseLegacyApiKeys(env = process.env) {
  const keys = [];
  const single = String(env.BRIDGE_CLAUDE_GEMINI_API_KEY || '').trim();
  if (single) keys.push(single);
  for (const value of splitCommaSeparated(env.BRIDGE_CLAUDE_GEMINI_API_KEYS || '')) {
    keys.push(value);
  }
  return uniqueNonEmpty(keys);
}

function buildTarget(rawTarget, { fallbackBaseUrl, fallbackModel } = {}) {
  const model = String(rawTarget?.model || fallbackModel || '').trim();
  const baseUrl = normalizeBaseUrl(rawTarget?.baseUrl, fallbackBaseUrl || DEFAULT_BASE_URL);
  const apiKey = String(rawTarget?.apiKey || '').trim();
  if (!model || !baseUrl || !apiKey) {
    return null;
  }
  return {
    model,
    baseUrl,
    apiKey,
  };
}

function parseTargetsJson(raw, defaults) {
  const value = String(raw || '').trim();
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return uniqueTargets(parsed
      .map((target) => buildTarget(target, defaults))
      .filter(Boolean));
  } catch {
    return [];
  }
}

export function parseGeminiReadonlyTargets(env = process.env) {
  const defaults = {
    fallbackBaseUrl: normalizeBaseUrl(env.BRIDGE_CLAUDE_GEMINI_BASE_URL, DEFAULT_BASE_URL),
    fallbackModel: String(env.BRIDGE_CLAUDE_GEMINI_MODEL || DEFAULT_MODEL).trim() || DEFAULT_MODEL,
  };
  const configuredTargets = parseTargetsJson(env.BRIDGE_CLAUDE_GEMINI_TARGETS, defaults);
  if (configuredTargets.length > 0) {
    return configuredTargets;
  }
  const legacyApiKeys = parseLegacyApiKeys(env);
  if (legacyApiKeys.length === 0) {
    return [];
  }
  return uniqueTargets(legacyApiKeys
    .map((apiKey) => buildTarget(
      {
        model: defaults.fallbackModel,
        baseUrl: defaults.fallbackBaseUrl,
        apiKey,
      },
      defaults,
    ))
    .filter(Boolean));
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
  constructor({ logger, env = process.env } = {}) {
    this.logger = logger;
    this.enabled = env.BRIDGE_CLAUDE_GEMINI_READONLY_ENABLED === 'true';
    this.targets = parseGeminiReadonlyTargets(env);
    this.threshold = parsePositiveInt(env.BRIDGE_CLAUDE_GEMINI_READONLY_THRESHOLD, DEFAULT_THRESHOLD);
    this.timeoutMs = parsePositiveInt(env.BRIDGE_CLAUDE_GEMINI_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
    this.targetCursor = 0;
  }

  isEnabled() {
    return this.enabled && this.targets.length > 0;
  }

  shouldAutoAllow(result) {
    return Boolean(result)
      && result.verdict === 'readonly'
      && result.readonlyProbability >= this.threshold;
  }

  nextCandidates() {
    if (this.targets.length === 0) return [];
    const start = this.targetCursor % this.targets.length;
    this.targetCursor = (this.targetCursor + 1) % this.targets.length;
    const ordered = [];
    for (let offset = 0; offset < this.targets.length; offset += 1) {
      const index = (start + offset) % this.targets.length;
      ordered.push({
        target: this.targets[index],
        targetIndex: index,
        targetTotal: this.targets.length,
      });
    }
    return ordered;
  }

  async classifyWithCandidate(command, {
    target,
    targetIndex,
    targetTotal,
  }) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const logPrefix = `gemini readonly classifier model=${target.model} target=${(targetIndex % targetTotal) + 1}/${targetTotal}`;
    try {
      const response = await fetch(
        `${target.baseUrl}/models/${encodeURIComponent(target.model)}:generateContent?key=${encodeURIComponent(target.apiKey)}`,
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
        this.logger?.warn?.(`${logPrefix} http=${response.status} body=${body.slice(0, 300)}`);
        return null;
      }

      const payload = await response.json();
      const text = extractResponseText(payload);
      const parsed = parseClassification(text);
      if (!parsed) {
        this.logger?.warn?.(`${logPrefix} invalid payload=${text.slice(0, 300)}`);
        return null;
      }
      return parsed;
    } catch (error) {
      this.logger?.warn?.(`${logPrefix} failed: ${String(error)}`);
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  async classifyCommand(command) {
    if (!this.isEnabled()) {
      return null;
    }
    const candidates = this.nextCandidates();
    for (const candidate of candidates) {
      const result = await this.classifyWithCandidate(command, candidate);
      if (result) {
        return result;
      }
    }
    return null;
  }
}
