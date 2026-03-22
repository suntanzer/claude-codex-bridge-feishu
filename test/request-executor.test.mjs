import assert from 'node:assert/strict';
import test from 'node:test';

import { createRequestExecutor } from '../src/app/request-executor.mjs';

test('runNextRequest ignores stored session when conversation runner differs', async () => {
  const conversations = {
    'thread-1': {
      cwd: '/tmp',
      model: '',
      runner: 'codex',
      sessionId: 'old-codex-session',
    },
  };
  const captured = [];
  let activeRequest = null;

  const queueItems = [
    {
      requestId: 'req-1',
      threadKey: 'thread-1',
      approvalScopeKey: 'thread-1',
      channelId: 'oc_chat_1',
      rootId: '',
      sourceMessageId: '',
      prompt: 'hello',
      userId: 'ou_user_1',
    },
  ];

  const queue = {
    dequeue() {
      return queueItems.shift() || null;
    },
    enqueue() {},
    list() {
      return queueItems.slice();
    },
    size() {
      return queueItems.length;
    },
  };

  const store = {
    getConversation(key) {
      return conversations[key] || null;
    },
    async patchConversation(key, patch) {
      conversations[key] = {
        ...(conversations[key] || {}),
        ...patch,
      };
      return conversations[key];
    },
    getRequest() {
      return {
        startedAt: new Date().toISOString(),
      };
    },
  };

  const requestService = {
    async markRunning() {},
    async markHeartbeat() {},
    async markWaitingApproval() {},
    async markCompleted() {},
    async markFailed() {},
  };

  const runner = {
    async run(ctx) {
      captured.push(ctx);
      return {
        ok: true,
        sessionId: 'new-claude-session',
        finalText: 'done',
        diagnostics: {},
      };
    },
  };

  const executor = createRequestExecutor({
    config: {
      bridgeRunner: 'claude-sdk',
      defaultCwd: '/tmp',
      codexProfile: '',
      typingIntervalMs: 60_000,
      progressMessageMs: 300_000,
    },
    store,
    queue,
    runner,
    runnerKey: 'claude-sdk',
    runnerName: 'Claude SDK',
    requestService,
    approvalService: {
      async createApproval() {
        throw new Error('approval should not be requested in this test');
      },
    },
    approvalStore: {
      async update() {},
    },
    postMessage: async () => {},
    postApprovalPrompt: async () => {},
    sendTyping: async () => {},
    clearTyping: async () => {},
    getActiveRequest: () => activeRequest,
    setActiveRequest: (value) => {
      activeRequest = value;
    },
    syncRuntime: async () => {},
  });

  await executor.runNextRequest();

  assert.equal(captured.length, 1);
  assert.equal(captured[0].sessionId, '');
  assert.equal(conversations['thread-1'].runner, 'claude-sdk');
  assert.equal(conversations['thread-1'].sessionId, 'new-claude-session');
});
