import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';

import { createFeishuEventHandler } from '../src/app/feishu-event-handler.mjs';
import { startFeishuWebhookServer } from '../src/transport/feishu-webhook-server.mjs';

function createLogger() {
  return {
    info() {},
    warn() {},
    error() {},
  };
}

test('p2p message event enqueues a request', async () => {
  const enqueued = [];
  const handler = createFeishuEventHandler({
    config: {
      feishuAllowedChatIds: [],
      feishuAllowedOpenIds: [],
      feishuGroupMode: 'mention_only',
      feishuSendWelcomeOnP2pEnter: false,
      commandPrefix: '!bridge',
      defaultCwd: '/tmp',
    },
    store: {
      getConversation() {
        return null;
      },
      async patchConversation() {},
    },
    approvalStore: {
      get() {
        return null;
      },
    },
    approvalService: {
      findByThread() {
        return null;
      },
      async resolveApproval() {},
    },
    onResolvedApproval: async () => {},
    handleCommand: async () => false,
    enqueueRequest: async (item) => {
      enqueued.push(item);
    },
    postMessage: async () => {},
  });

  const response = await handler({
    header: {
      event_type: 'im.message.receive_v1',
    },
    event: {
      sender: {
        sender_id: {
          open_id: 'ou_user_1',
        },
      },
      message: {
        chat_id: 'oc_chat_1',
        chat_type: 'p2p',
        message_id: 'om_msg_1',
        content: '{"text":"hello bridge"}',
      },
    },
  });

  assert.deepEqual(response, { code: 0, msg: 'ok' });
  assert.equal(enqueued.length, 1);
  assert.deepEqual(enqueued[0], {
    threadKey: 'feishu:p2p:oc_chat_1',
    approvalScopeKey: 'feishu:p2p:oc_chat_1',
    channelId: 'oc_chat_1',
    rootId: '',
    sourceMessageId: 'om_msg_1',
    prompt: 'hello bridge',
    userId: 'ou_user_1',
  });
});

test('group message without mention is ignored in mention_only mode', async () => {
  const enqueued = [];
  const handler = createFeishuEventHandler({
    config: {
      feishuAllowedChatIds: [],
      feishuAllowedOpenIds: [],
      feishuGroupMode: 'mention_only',
      feishuSendWelcomeOnP2pEnter: false,
      commandPrefix: '!bridge',
      defaultCwd: '/tmp',
    },
    store: {
      getConversation() {
        return null;
      },
      async patchConversation() {},
    },
    approvalStore: {
      get() {
        return null;
      },
    },
    approvalService: {
      findByThread() {
        return null;
      },
      async resolveApproval() {},
    },
    onResolvedApproval: async () => {},
    handleCommand: async () => false,
    enqueueRequest: async (item) => {
      enqueued.push(item);
    },
    postMessage: async () => {},
  });

  await handler({
    header: {
      event_type: 'im.message.receive_v1',
    },
    event: {
      sender: {
        sender_id: {
          open_id: 'ou_user_2',
        },
      },
      message: {
        chat_id: 'oc_group_1',
        chat_type: 'group',
        message_id: 'om_group_1',
        content: '{"text":"plain group text"}',
        mentions: [],
      },
    },
  });

  assert.equal(enqueued.length, 0);
});

test('text approval fallback resolves a pending approval', async () => {
  const resolved = [];
  const posted = [];
  const approval = {
    approvalId: 'approval-1',
    status: 'pending',
    kind: 'tool',
    threadKey: 'feishu:p2p:oc_chat_2',
  };

  const handler = createFeishuEventHandler({
    config: {
      feishuAllowedChatIds: [],
      feishuAllowedOpenIds: [],
      feishuGroupMode: 'mention_only',
      feishuSendWelcomeOnP2pEnter: false,
      commandPrefix: '!bridge',
      defaultCwd: '/tmp',
    },
    store: {
      getConversation() {
        return null;
      },
      async patchConversation() {},
    },
    approvalStore: {
      get() {
        return approval;
      },
    },
    approvalService: {
      findByThread(threadKey) {
        return threadKey === approval.threadKey ? approval : null;
      },
      async resolveApproval(approvalId, decision, meta) {
        resolved.push({ approvalId, decision, meta });
      },
    },
    onResolvedApproval: async () => {},
    handleCommand: async () => false,
    enqueueRequest: async () => {
      throw new Error('approval reply should not enqueue a normal request');
    },
    postMessage: async (...args) => {
      posted.push(args);
    },
  });

  await handler({
    header: {
      event_type: 'im.message.receive_v1',
    },
    event: {
      sender: {
        sender_id: {
          open_id: 'ou_user_3',
        },
      },
      message: {
        chat_id: 'oc_chat_2',
        chat_type: 'p2p',
        message_id: 'om_msg_2',
        content: '{"text":"1"}',
      },
    },
  });

  assert.deepEqual(resolved, [
    {
      approvalId: 'approval-1',
      decision: 'approve_once',
      meta: {
        via: 'text',
        userId: 'ou_user_3',
        userName: 'ou_user_3',
      },
    },
  ]);
  assert.equal(posted.length, 1);
  assert.equal(posted[0][2], 'Authorization recorded: Approve once.');
});

test('card action trigger resolves a pending approval', async () => {
  const resolved = [];
  const forwarded = [];
  const approval = {
    approvalId: 'approval-card-1',
    status: 'pending',
    kind: 'tool',
    threadKey: 'feishu:p2p:oc_chat_3',
  };

  const handler = createFeishuEventHandler({
    config: {
      feishuAllowedChatIds: [],
      feishuAllowedOpenIds: [],
      feishuGroupMode: 'mention_only',
      feishuSendWelcomeOnP2pEnter: false,
      commandPrefix: '!bridge',
      defaultCwd: '/tmp',
    },
    store: {
      getConversation() {
        return null;
      },
      async patchConversation() {},
    },
    approvalStore: {
      get(approvalId) {
        return approvalId === approval.approvalId ? approval : null;
      },
    },
    approvalService: {
      findByThread() {
        return null;
      },
      async resolveApproval(approvalId, decision, meta) {
        resolved.push({ approvalId, decision, meta });
      },
    },
    onResolvedApproval: async (...args) => {
      forwarded.push(args);
    },
    handleCommand: async () => false,
    enqueueRequest: async () => {
      throw new Error('card action should not enqueue a normal request directly');
    },
    postMessage: async () => {},
  });

  const response = await handler({
    header: {
      event_type: 'card.action.trigger',
    },
    event: {
      operator: {
        open_id: 'ou_user_4',
      },
      action: {
        value: {
          approval_id: 'approval-card-1',
          decision: 'approve_once',
        },
      },
    },
  });

  assert.deepEqual(resolved, [
    {
      approvalId: 'approval-card-1',
      decision: 'approve_once',
      meta: {
        via: 'card',
        userId: 'ou_user_4',
        userName: 'ou_user_4',
      },
    },
  ]);
  assert.equal(forwarded.length, 1);
  assert.equal(response?.toast?.type, 'success');
  assert.equal(response?.toast?.content, 'Recorded: Approve once.');
});

test('webhook server responds to url verification and forwards events', async (t) => {
  const events = [];
  const server = startFeishuWebhookServer({
    logger: createLogger(),
    listenHost: '127.0.0.1',
    port: 0,
    path: '/feishu/events/pilot',
    encryptKey: '',
    verificationToken: 'vtok',
    onEvent: async (payload) => {
      events.push(payload);
      return { code: 0, msg: 'event-ok' };
    },
  });

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const verifyResponse = await fetch(`http://127.0.0.1:${address.port}/feishu/events/pilot`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      type: 'url_verification',
      token: 'vtok',
      challenge: 'challenge-123',
    }),
  });

  assert.equal(verifyResponse.status, 200);
  assert.deepEqual(await verifyResponse.json(), { challenge: 'challenge-123' });

  const eventResponse = await fetch(`http://127.0.0.1:${address.port}/feishu/events/pilot`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      schema: '2.0',
      token: 'vtok',
      header: {
        event_type: 'im.message.receive_v1',
      },
      event: {
        sender: {
          sender_id: {
            open_id: 'ou_user_4',
          },
        },
        message: {
          chat_id: 'oc_chat_4',
          chat_type: 'p2p',
          message_id: 'om_msg_4',
          content: '{"text":"hello"}',
        },
      },
    }),
  });

  assert.equal(eventResponse.status, 200);
  assert.deepEqual(await eventResponse.json(), { code: 0, msg: 'event-ok' });
  assert.equal(events.length, 1);
  assert.equal(events[0].event.message.chat_id, 'oc_chat_4');
});
