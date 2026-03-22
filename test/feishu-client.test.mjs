import assert from 'node:assert/strict';
import test from 'node:test';

import { FeishuClient } from '../src/transport/feishu-client.mjs';

function createJsonResponse(body) {
  return {
    ok: true,
    async json() {
      return body;
    },
  };
}

test('postRichText sends Feishu post payload with md content', async (t) => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('/tenant_access_token/internal')) {
      return createJsonResponse({
        code: 0,
        tenant_access_token: 'tenant-token',
        expire: 7200,
      });
    }
    return createJsonResponse({
      code: 0,
      data: {
        message_id: 'om_reply_1',
      },
    });
  };

  const client = new FeishuClient({
    appId: 'cli_test',
    appSecret: 'secret_test',
    logger: { info() {}, warn() {}, error() {} },
  });

  await client.postRichText({
    chatId: 'oc_chat_1',
    text: 'Hello **Feishu**',
  });

  assert.equal(calls.length, 2);
  const body = JSON.parse(String(calls[1].init.body || '{}'));
  assert.equal(body.msg_type, 'post');
  assert.equal(body.receive_id, 'oc_chat_1');
  assert.deepEqual(JSON.parse(body.content), {
    zh_cn: {
      content: [
        [
          {
            tag: 'md',
            text: 'Hello **Feishu**',
          },
        ],
      ],
    },
  });
});

test('postCard sends raw card json as interactive content', async (t) => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('/tenant_access_token/internal')) {
      return createJsonResponse({
        code: 0,
        tenant_access_token: 'tenant-token',
        expire: 7200,
      });
    }
    return createJsonResponse({
      code: 0,
      data: {
        message_id: 'om_card_1',
      },
    });
  };

  const client = new FeishuClient({
    appId: 'cli_test',
    appSecret: 'secret_test',
    logger: { info() {}, warn() {}, error() {} },
  });

  const card = {
    schema: '2.0',
    body: {
      elements: [
        {
          tag: 'markdown',
          content: '```js\nconsole.log(1)\n```',
        },
      ],
    },
  };

  await client.postCard({
    chatId: 'oc_chat_2',
    card,
  });

  assert.equal(calls.length, 2);
  const body = JSON.parse(String(calls[1].init.body || '{}'));
  assert.equal(body.msg_type, 'interactive');
  assert.equal(body.receive_id, 'oc_chat_2');
  assert.equal(body.content, JSON.stringify(card));
});
