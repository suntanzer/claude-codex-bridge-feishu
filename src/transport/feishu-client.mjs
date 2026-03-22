function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function textPayload(text) {
  return JSON.stringify({ text: String(text ?? '') });
}

function postPayload(text) {
  return JSON.stringify({
    zh_cn: {
      content: [
        [
          {
            tag: 'md',
            text: String(text ?? ''),
          },
        ],
      ],
    },
  });
}

function interactivePayload(card) {
  return JSON.stringify(card);
}

export class FeishuClient {
  constructor({ appId, appSecret, baseUrl = 'https://open.feishu.cn', logger }) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.baseUrl = trimTrailingSlash(baseUrl);
    this.logger = logger;
    this.cachedToken = '';
    this.cachedTokenExpiresAtMs = 0;
  }

  async getTenantAccessToken() {
    const now = Date.now();
    if (this.cachedToken && now < this.cachedTokenExpiresAtMs) {
      return this.cachedToken;
    }

    const response = await fetch(`${this.baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        app_id: this.appId,
        app_secret: this.appSecret,
      }),
    });
    const body = await response.json();
    if (!response.ok || body?.code !== 0 || !body?.tenant_access_token) {
      throw new Error(`Feishu token request failed: HTTP ${response.status} ${JSON.stringify(body)}`);
    }

    const expiresIn = Number(body.expire || 7200);
    this.cachedToken = body.tenant_access_token;
    this.cachedTokenExpiresAtMs = now + Math.max((expiresIn - 120) * 1000, 60_000);
    return this.cachedToken;
  }

  async request(path, init = {}) {
    const token = await this.getTenantAccessToken();
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
        ...(init.headers || {}),
      },
    });
    const body = await response.json();
    if (!response.ok || body?.code !== 0) {
      throw new Error(`Feishu ${path} failed: HTTP ${response.status} ${JSON.stringify(body)}`);
    }
    return body;
  }

  async getMe() {
    await this.getTenantAccessToken();
    return { appId: this.appId };
  }

  async sendTextMessage({ chatId, text }) {
    return this.request('/open-apis/im/v1/messages?receive_id_type=chat_id', {
      method: 'POST',
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: 'text',
        content: textPayload(text),
      }),
    });
  }

  async sendPostMessage({ chatId, text }) {
    return this.request('/open-apis/im/v1/messages?receive_id_type=chat_id', {
      method: 'POST',
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: 'post',
        content: postPayload(text),
      }),
    });
  }

  async sendInteractiveMessage({ chatId, card }) {
    return this.request('/open-apis/im/v1/messages?receive_id_type=chat_id', {
      method: 'POST',
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: 'interactive',
        content: interactivePayload(card),
      }),
    });
  }

  async replyTextMessage({ messageId, text, replyInThread = true }) {
    return this.request(`/open-apis/im/v1/messages/${messageId}/reply`, {
      method: 'POST',
      body: JSON.stringify({
        msg_type: 'text',
        content: textPayload(text),
        reply_in_thread: replyInThread,
      }),
    });
  }

  async replyPostMessage({ messageId, text, replyInThread = true }) {
    return this.request(`/open-apis/im/v1/messages/${messageId}/reply`, {
      method: 'POST',
      body: JSON.stringify({
        msg_type: 'post',
        content: postPayload(text),
        reply_in_thread: replyInThread,
      }),
    });
  }

  async replyInteractiveMessage({ messageId, card, replyInThread = true }) {
    return this.request(`/open-apis/im/v1/messages/${messageId}/reply`, {
      method: 'POST',
      body: JSON.stringify({
        msg_type: 'interactive',
        content: interactivePayload(card),
        reply_in_thread: replyInThread,
      }),
    });
  }

  async postText({ chatId, replyToMessageId = '', text, replyInThread = true }) {
    if (replyToMessageId) {
      return this.replyTextMessage({
        messageId: replyToMessageId,
        text,
        replyInThread,
      });
    }
    return this.sendTextMessage({ chatId, text });
  }

  async postRichText({ chatId, replyToMessageId = '', text, replyInThread = true }) {
    if (replyToMessageId) {
      return this.replyPostMessage({
        messageId: replyToMessageId,
        text,
        replyInThread,
      });
    }
    return this.sendPostMessage({ chatId, text });
  }

  async postCard({ chatId, replyToMessageId = '', card, replyInThread = true }) {
    if (replyToMessageId) {
      return this.replyInteractiveMessage({
        messageId: replyToMessageId,
        card,
        replyInThread,
      });
    }
    return this.sendInteractiveMessage({ chatId, card });
  }

  async addTypingReaction({ messageId }) {
    const body = await this.request(`/open-apis/im/v1/messages/${messageId}/reactions`, {
      method: 'POST',
      body: JSON.stringify({
        reaction_type: {
          emoji_type: 'Typing',
        },
      }),
    });
    return {
      reactionId: String(body?.data?.reaction_id || '').trim(),
    };
  }

  async removeReaction({ messageId, reactionId }) {
    return this.request(`/open-apis/im/v1/messages/${messageId}/reactions/${reactionId}`, {
      method: 'DELETE',
    });
  }

  async downloadResource({ messageId, fileKey, type = 'file', maxBytes = 0 }) {
    const token = await this.getTenantAccessToken();
    const url = `${this.baseUrl}/open-apis/im/v1/messages/${messageId}/resources/${fileKey}?type=${type}`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Feishu resource download failed: HTTP ${response.status} ${text.slice(0, 300)}`);
    }
    const contentType = String(response.headers.get('content-type') || '').split(';')[0].trim();
    const disposition = String(response.headers.get('content-disposition') || '');
    let fileName = '';
    const filenameMatch = disposition.match(/filename\*?=(?:UTF-8''|"?)([^";]+)/i);
    if (filenameMatch) {
      try {
        fileName = decodeURIComponent(filenameMatch[1].replace(/^"/, '').replace(/"$/, ''));
      } catch {
        fileName = filenameMatch[1].replace(/^"/, '').replace(/"$/, '');
      }
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (maxBytes > 0 && buffer.length > maxBytes) {
      throw new Error(`File exceeds size limit: ${buffer.length} > ${maxBytes} bytes`);
    }
    return { buffer, contentType, fileName, size: buffer.length };
  }
}
