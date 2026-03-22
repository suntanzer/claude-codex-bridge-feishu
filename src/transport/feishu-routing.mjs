function asJson(raw) {
  if (!raw) return {};
  try {
    return JSON.parse(String(raw));
  } catch {
    return {};
  }
}

export function makeP2pThreadKey(chatId) {
  return `feishu:p2p:${chatId}`;
}

export function makeGroupRootThreadKey(chatId, rootMessageId) {
  return `feishu:group:${chatId}:root:${rootMessageId}`;
}

export function extractFeishuTextContent(message) {
  const msgType = String(message?.message_type || '').trim();
  const content = asJson(message?.content);

  if (msgType === 'text') {
    return String(content?.text || '').trim();
  }

  if (msgType === 'post') {
    const sections = [];
    const localeContent = content?.zh_cn || content?.en_us || content?.ja_jp || Object.values(content || {})[0];
    const title = String(localeContent?.title || '').trim();
    if (title) {
      sections.push(title);
    }
    const rows = Array.isArray(localeContent?.content) ? localeContent.content : [];
    for (const row of rows) {
      if (!Array.isArray(row)) continue;
      for (const element of row) {
        if (element?.tag === 'text' && element.text) {
          sections.push(String(element.text));
        } else if (element?.tag === 'a' && element.text) {
          sections.push(String(element.text));
        }
      }
    }
    return sections.join('').trim();
  }

  if (msgType === 'file') {
    return String(content?.file_name || '').trim();
  }

  return String(content?.text || '').trim();
}

export function extractFeishuMediaRefs(message) {
  const msgType = String(message?.message_type || '').trim();
  const content = asJson(message?.content);
  const refs = [];

  if (msgType === 'image') {
    const key = String(content?.image_key || '').trim();
    if (key) {
      refs.push({ type: 'image', fileKey: key, fileName: '' });
    }
  } else if (msgType === 'file') {
    const key = String(content?.file_key || '').trim();
    const name = String(content?.file_name || '').trim();
    if (key) {
      refs.push({ type: 'file', fileKey: key, fileName: name });
    }
  } else if (msgType === 'media') {
    const key = String(content?.file_key || '').trim();
    const name = String(content?.file_name || '').trim();
    if (key) {
      refs.push({ type: 'file', fileKey: key, fileName: name });
    }
  } else if (msgType === 'audio') {
    const key = String(content?.file_key || '').trim();
    if (key) {
      refs.push({ type: 'file', fileKey: key, fileName: '' });
    }
  } else if (msgType === 'sticker') {
    const key = String(content?.file_key || '').trim();
    if (key) {
      refs.push({ type: 'file', fileKey: key, fileName: '' });
    }
  } else if (msgType === 'post') {
    const localeContent = content?.zh_cn || content?.en_us || content?.ja_jp || Object.values(content || {})[0];
    const rows = Array.isArray(localeContent?.content) ? localeContent.content : [];
    for (const row of rows) {
      if (!Array.isArray(row)) continue;
      for (const element of row) {
        if (element?.tag === 'img') {
          const key = String(element.image_key || '').trim();
          if (key) {
            refs.push({ type: 'image', fileKey: key, fileName: '' });
          }
        }
      }
    }
  }

  return refs;
}

export function extractFeishuThreadContext(event) {
  const message = event?.message || {};
  const chatId = String(message.chat_id || '').trim();
  const chatType = String(message.chat_type || '').trim();
  const isP2p = chatType === 'p2p';
  const rootMessageId = String(message.root_id || message.parent_id || message.message_id || '').trim();

  if (isP2p) {
    return {
      chatId,
      chatType,
      replyRootId: '',
      threadKey: makeP2pThreadKey(chatId),
      approvalScopeKey: makeP2pThreadKey(chatId),
    };
  }

  return {
    chatId,
    chatType,
    replyRootId: rootMessageId,
    threadKey: makeGroupRootThreadKey(chatId, rootMessageId),
    approvalScopeKey: makeGroupRootThreadKey(chatId, rootMessageId),
  };
}

export function isFeishuGroupMentionEvent(source) {
  const message = source?.message || source;
  return Array.isArray(message?.mentions) && message.mentions.length > 0;
}
