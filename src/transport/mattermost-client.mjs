function normalizeBaseUrl(baseUrl) {
  return baseUrl.replace(/\/+$/, '');
}

function toWebSocketUrl(baseUrl) {
  if (baseUrl.startsWith('https://')) {
    return `wss://${baseUrl.slice('https://'.length)}/api/v4/websocket`;
  }
  if (baseUrl.startsWith('http://')) {
    return `ws://${baseUrl.slice('http://'.length)}/api/v4/websocket`;
  }
  throw new Error(`Unsupported Mattermost base URL: ${baseUrl}`);
}

export class MattermostClient {
  constructor({ baseUrl, botToken, logger }) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.botToken = botToken;
    this.logger = logger;
    this.seq = 1;
  }

  async request(path, init = {}) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.botToken}`,
        'Content-Type': 'application/json',
        ...(init.headers || {}),
      },
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Mattermost ${path} failed: HTTP ${response.status} ${body}`);
    }
    return response.json();
  }

  async getMe() {
    return this.request('/api/v4/users/me');
  }

  async createPost({ channelId, message, rootId = '', props, fileIds, priority }) {
    return this.request('/api/v4/posts', {
      method: 'POST',
      body: JSON.stringify({
        channel_id: channelId,
        root_id: rootId,
        message,
        ...(Array.isArray(fileIds) && fileIds.length > 0 ? { file_ids: fileIds } : {}),
        ...(priority ? { priority } : {}),
        ...(props ? { props } : {}),
      }),
    });
  }

  async updatePost({ postId, message, props, fileIds, priority }) {
    return this.request(`/api/v4/posts/${postId}`, {
      method: 'PUT',
      body: JSON.stringify({
        id: postId,
        message,
        ...(Array.isArray(fileIds) ? { file_ids: fileIds } : {}),
        ...(priority ? { priority } : {}),
        ...(props ? { props } : {}),
      }),
    });
  }

  async sendTyping({ channelId, rootId = '' }) {
    const payload = { channel_id: channelId };
    if (rootId) {
      payload.parent_id = rootId;
    }
    return this.request('/api/v4/users/me/typing', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  async connectWebSocket({ onPost }) {
    const wsUrl = toWebSocketUrl(this.baseUrl);
    let backoffMs = 2000;
    while (true) {
      try {
        await this.#connectOnce(wsUrl, onPost);
        backoffMs = 2000;
      } catch (error) {
        this.logger.error(`mattermost websocket failure: ${String(error)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      backoffMs = Math.min(backoffMs * 2, 30_000);
    }
  }

  async #connectOnce(wsUrl, onPost) {
    await new Promise((resolve, reject) => {
      let opened = false;
      const ws = new WebSocket(wsUrl);

      ws.addEventListener('open', () => {
        opened = true;
        this.logger.info(`mattermost websocket connected: ${wsUrl}`);
        ws.send(JSON.stringify({
          seq: this.seq++,
          action: 'authentication_challenge',
          data: { token: this.botToken },
        }));
      });

      ws.addEventListener('message', async (event) => {
        let payload;
        try {
          payload = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (payload?.event !== 'posted') return;
        const rawPost = payload?.data?.post;
        if (!rawPost) return;
        let post;
        try {
          post = typeof rawPost === 'string' ? JSON.parse(rawPost) : rawPost;
        } catch {
          return;
        }
        try {
          await onPost(post, payload);
        } catch (error) {
          this.logger.error(`mattermost onPost failed: ${String(error)}`);
        }
      });

      ws.addEventListener('close', (event) => {
        if (!opened) {
          reject(new Error(`websocket closed before open (${event.code})`));
          return;
        }
        this.logger.info(`mattermost websocket closed: ${event.code}`);
        resolve();
      });

      ws.addEventListener('error', () => {
        try { ws.close(); } catch {}
      });
    });
  }
}
