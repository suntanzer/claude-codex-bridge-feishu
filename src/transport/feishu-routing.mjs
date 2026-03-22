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
  const content = asJson(message?.content);
  return String(content?.text || '').trim();
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
