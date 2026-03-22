import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GeminiReadonlyClassifier,
  parseGeminiReadonlyTargets,
} from '../src/runner/gemini-readonly.mjs';

function createLogger() {
  return {
    info() {},
    warn() {},
    error() {},
  };
}

function createGeminiResponse({
  ok = true,
  status = 200,
  body = {
    candidates: [
      {
        content: {
          parts: [
            {
              text: JSON.stringify({
                readonly_probability: 100,
                verdict: 'readonly',
                reason: 'inspection only',
              }),
            },
          ],
        },
      },
    ],
  },
  text = '',
} = {}) {
  return {
    ok,
    status,
    async json() {
      return body;
    },
    async text() {
      return text || JSON.stringify(body);
    },
  };
}

test('parseGeminiReadonlyTargets prefers flat target list and deduplicates identical entries', () => {
  const targets = parseGeminiReadonlyTargets({
    BRIDGE_CLAUDE_GEMINI_TARGETS: JSON.stringify([
      {
        model: 'gemini-2.5-flash-lite',
        apiKey: 'alpha',
      },
      {
        model: 'gemini-2.5-flash-lite',
        apiKey: 'beta',
      },
      {
        model: 'gemini-2.5-pro',
        apiKey: 'gamma',
        baseUrl: 'https://example.test/v1beta/',
      },
      {
        model: 'gemini-2.5-pro',
        apiKey: 'gamma',
        baseUrl: 'https://example.test/v1beta/',
      },
    ]),
    BRIDGE_CLAUDE_GEMINI_MODEL: 'legacy-model',
    BRIDGE_CLAUDE_GEMINI_API_KEYS: 'legacy-key',
  });

  assert.deepEqual(
    targets.map((target) => ({
      model: target.model,
      baseUrl: target.baseUrl,
      apiKey: target.apiKey,
    })),
    [
      {
        model: 'gemini-2.5-flash-lite',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        apiKey: 'alpha',
      },
      {
        model: 'gemini-2.5-flash-lite',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        apiKey: 'beta',
      },
      {
        model: 'gemini-2.5-pro',
        baseUrl: 'https://example.test/v1beta',
        apiKey: 'gamma',
      },
    ],
  );
});

test('parseGeminiReadonlyTargets falls back to legacy single-model vars', () => {
  const targets = parseGeminiReadonlyTargets({
    BRIDGE_CLAUDE_GEMINI_MODEL: 'gemini-2.5-flash-lite',
    BRIDGE_CLAUDE_GEMINI_BASE_URL: 'https://example.test/v1beta/',
    BRIDGE_CLAUDE_GEMINI_API_KEY: 'alpha',
    BRIDGE_CLAUDE_GEMINI_API_KEYS: 'alpha,beta',
  });

  assert.deepEqual(
    targets.map((target) => ({
      model: target.model,
      baseUrl: target.baseUrl,
      apiKey: target.apiKey,
    })),
    [
      {
        model: 'gemini-2.5-flash-lite',
        baseUrl: 'https://example.test/v1beta',
        apiKey: 'alpha',
      },
      {
        model: 'gemini-2.5-flash-lite',
        baseUrl: 'https://example.test/v1beta',
        apiKey: 'beta',
      },
    ],
  );
});

test('classifier rotates across flat target entries', async (t) => {
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    calls.push(url);
    return createGeminiResponse();
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  const classifier = new GeminiReadonlyClassifier({
    logger: createLogger(),
    env: {
      BRIDGE_CLAUDE_GEMINI_READONLY_ENABLED: 'true',
      BRIDGE_CLAUDE_GEMINI_TARGETS: JSON.stringify([
        {
          model: 'gemini-2.5-flash-lite',
          apiKey: 'alpha',
        },
        {
          model: 'gemini-2.5-flash-lite',
          apiKey: 'beta',
        },
        {
          model: 'gemini-2.5-pro',
          apiKey: 'gamma',
        },
      ]),
    },
  });

  await classifier.classifyCommand('pwd');
  await classifier.classifyCommand('pwd');
  await classifier.classifyCommand('pwd');

  assert.deepEqual(calls, [
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=alpha',
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=beta',
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=gamma',
  ]);
});

test('classifier falls through remaining flat targets after failures', async (t) => {
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    calls.push(url);
    if (url.endsWith('key=alpha')) {
      return createGeminiResponse({
        ok: false,
        status: 429,
        text: 'quota exceeded',
      });
    }
    if (url.endsWith('key=beta')) {
      return createGeminiResponse({
        body: {
          candidates: [
            {
              content: {
                parts: [{ text: 'not-json' }],
              },
            },
          ],
        },
      });
    }
    return createGeminiResponse();
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  const classifier = new GeminiReadonlyClassifier({
    logger: createLogger(),
    env: {
      BRIDGE_CLAUDE_GEMINI_READONLY_ENABLED: 'true',
      BRIDGE_CLAUDE_GEMINI_TARGETS: JSON.stringify([
        {
          model: 'gemini-2.5-flash-lite',
          apiKey: 'alpha',
        },
        {
          model: 'gemini-2.5-flash-lite',
          apiKey: 'beta',
        },
        {
          model: 'gemini-2.5-pro',
          apiKey: 'gamma',
        },
      ]),
    },
  });

  const result = await classifier.classifyCommand('pwd');
  assert.equal(result?.readonlyProbability, 100);
  assert.deepEqual(calls, [
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=alpha',
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=beta',
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=gamma',
  ]);
});
