import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';

import { startInteractionServer } from '../src/app/interaction-server.mjs';
import { createPostHandler } from '../src/app/post-handler.mjs';

function createLogger() {
  return {
    info() {},
    warn() {},
    error() {},
  };
}

test('button approvals resolve for non-requester users', async (t) => {
  const approval = {
    approvalId: 'approval-1',
    status: 'pending',
    kind: 'tool',
    requestedByUserId: 'requester',
  };
  const resolved = [];
  const callbacks = [];
  const server = startInteractionServer({
    logger: createLogger(),
    approvalStore: {
      get(id) {
        return id === approval.approvalId ? approval : null;
      },
    },
    approvalService: {
      async resolveApproval(approvalId, decision, meta) {
        resolved.push({ approvalId, decision, meta });
        approval.status = 'resolved';
      },
    },
    onResolvedApproval: async (...args) => {
      callbacks.push(args);
    },
    interactionPath: '/mattermost/actions/claude',
    interactionPort: 0,
    interactionListenHost: '127.0.0.1',
    callbackUrl: 'https://example.invalid/ccmm/axi/claude/actions',
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });
  await once(server, 'listening');

  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const response = await fetch(`http://127.0.0.1:${address.port}/mattermost/actions/claude`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      context: {
        approval_id: approval.approvalId,
        decision: 'approve_once',
        channel_id: 'channel-1',
      },
      user_id: 'reviewer',
      user_name: 'reviewer-name',
    }),
  });

  assert.equal(response.status, 200);
  assert.equal(resolved.length, 1);
  assert.deepEqual(resolved[0], {
    approvalId: 'approval-1',
    decision: 'approve_once',
    meta: {
      via: 'button',
      userId: 'reviewer',
      userName: 'reviewer-name',
    },
  });
  assert.equal(callbacks.length, 1);

  const body = await response.json();
  assert.equal(body.ephemeral_text, 'Recorded: Approve once');
});

test('text approval fallback still resolves for non-requester users', async () => {
  const approval = {
    approvalId: 'approval-2',
    status: 'pending',
    kind: 'tool',
    requestedByUserId: 'requester',
    threadKey: 'mattermost:channel-1:root-1',
    channelId: 'channel-1',
    rootId: 'root-1',
  };
  const resolved = [];
  const messages = [];
  const handler = createPostHandler({
    config: {
      allowedChannels: ['channel-1'],
      allowedUsers: [],
      commandPrefix: '!bridge',
      defaultCwd: '/tmp',
    },
    store: {
      getConversation() {
        return null;
      },
      async patchConversation() {},
    },
    me: { id: 'bot-user' },
    approvalService: {
      findByThread(threadKey) {
        return threadKey === approval.threadKey ? approval : null;
      },
      findByChannel() {
        return null;
      },
      async resolveApproval(approvalId, decision, meta) {
        resolved.push({ approvalId, decision, meta });
      },
    },
    onResolvedApproval: async () => {},
    handleCommand: async () => false,
    enqueueRequest: async () => {
      throw new Error('approval replies should not enqueue a new request');
    },
    postMessage: async (...args) => {
      messages.push(args);
    },
  });

  await handler(
    {
      id: 'post-1',
      user_id: 'reviewer',
      channel_id: 'channel-1',
      root_id: 'root-1',
      message: '1',
      props: {},
    },
    {
      data: {
        channel_type: 'O',
      },
    },
  );

  assert.deepEqual(resolved, [
    {
      approvalId: 'approval-2',
      decision: 'approve_once',
      meta: {
        via: 'text',
        userId: 'reviewer',
        userName: 'reviewer',
      },
    },
  ]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0][2], 'Authorization recorded: Approve once.');
});
