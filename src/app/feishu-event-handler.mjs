import { approvalDecisionLabel, normalizeApprovalDecision } from '../approval/decisions.mjs';
import {
  extractFeishuTextContent,
  extractFeishuMediaRefs,
  extractFeishuThreadContext,
  isFeishuGroupMentionEvent,
} from '../transport/feishu-routing.mjs';

function parseCommand(text, prefix = '!bridge') {
  const trimmed = String(text || '').trim();
  if (!trimmed.toLowerCase().startsWith(prefix.toLowerCase())) {
    return null;
  }
  const rest = trimmed.slice(prefix.length).trim();
  const [command = 'help', ...args] = rest ? rest.split(/\s+/) : [];
  return { command: command.toLowerCase(), args, rawArgs: rest };
}

export function createFeishuEventHandler({
  config,
  store,
  approvalStore,
  approvalService,
  onResolvedApproval,
  handleCommand,
  enqueueRequest,
  postMessage,
  buildIncomingPrompt,
  feishu,
}) {
  function extractCardActionValue(event) {
    const action = event?.action || {};
    if (action?.value && typeof action.value === 'object' && !Array.isArray(action.value)) {
      return action.value;
    }
    if (action?.form_value && typeof action.form_value === 'object' && !Array.isArray(action.form_value)) {
      return action.form_value;
    }
    return {};
  }

  function extractOperatorOpenId(event) {
    return String(
      event?.operator?.open_id
      || event?.operator?.operator_id?.open_id
      || event?.operator_id?.open_id
      || '',
    ).trim();
  }

  async function onMessageEvent(event) {
    const sender = event?.sender || {};
    const senderOpenId = String(sender?.sender_id?.open_id || '').trim();
    const message = event?.message || {};
    const sourceMessageId = String(message?.message_id || '').trim();
    const text = extractFeishuTextContent(message);
    const mediaRefs = extractFeishuMediaRefs(message);
    if (!text && mediaRefs.length === 0) return;

    const { chatId, chatType, replyRootId, threadKey, approvalScopeKey } = extractFeishuThreadContext(event);
    if (!chatId) return;

    if (config.feishuAllowedChatIds.length > 0 && !config.feishuAllowedChatIds.includes(chatId)) {
      return;
    }
    if (config.feishuAllowedOpenIds.length > 0 && !config.feishuAllowedOpenIds.includes(senderOpenId)) {
      return;
    }
    if (chatType === 'group' && config.feishuGroupMode === 'mention_only' && !isFeishuGroupMentionEvent(message)) {
      return;
    }

    const conversation = store.getConversation(threadKey) || {
      key: threadKey,
      channelId: chatId,
      rootId: replyRootId,
      userId: senderOpenId,
      cwd: config.defaultCwd,
      model: '',
      sessionId: '',
      updatedAt: Date.now(),
    };

    const pendingApproval = approvalService.findByThread(approvalScopeKey);
    const approvalDecision = normalizeApprovalDecision(text, pendingApproval?.kind || 'tool');
    if (approvalDecision && pendingApproval) {
      await approvalService.resolveApproval(pendingApproval.approvalId, approvalDecision, {
        via: 'text',
        userId: senderOpenId,
        userName: senderOpenId,
      });
      await onResolvedApproval?.(pendingApproval, approvalDecision, {
        via: 'text',
        userId: senderOpenId,
        userName: senderOpenId,
      });
      if (pendingApproval.kind !== 'checkpoint') {
        await postMessage(chatId, replyRootId, `Authorization recorded: ${approvalDecisionLabel(approvalDecision)}.`);
      }
      return;
    }

    const command = parseCommand(text, config.commandPrefix);
    if (command) {
      const handled = await handleCommand({
        channelId: chatId,
        rootId: replyRootId,
        threadKey,
        approvalScopeKey,
        command,
      });
      if (handled) return;
    }

    await store.patchConversation(threadKey, {
      ...conversation,
      updatedAt: Date.now(),
    });

    const prompt = buildIncomingPrompt
      ? await buildIncomingPrompt({ messageId: sourceMessageId, mediaRefs, message: text })
      : text;

    await enqueueRequest({
      threadKey,
      approvalScopeKey,
      channelId: chatId,
      rootId: replyRootId,
      sourceMessageId,
      prompt,
      userId: senderOpenId,
    });
  }

  async function onCardActionEvent(event) {
    const value = extractCardActionValue(event);
    const approvalId = String(value?.approval_id || '').trim();
    const approval = approvalStore?.get?.(approvalId);
    if (!approval || approval.status !== 'pending') {
      return {
        toast: {
          type: 'warning',
          content: 'This approval is no longer active.',
        },
      };
    }

    const decision = normalizeApprovalDecision(value?.decision, approval.kind || 'tool');
    if (!decision) {
      return {
        toast: {
          type: 'error',
          content: 'Unsupported approval action.',
        },
      };
    }

    const userId = extractOperatorOpenId(event);
    await approvalService.resolveApproval(approvalId, decision, {
      via: 'card',
      userId,
      userName: userId || 'unknown',
    });
    await onResolvedApproval?.(approval, decision, {
      via: 'card',
      userId,
      userName: userId || 'unknown',
    });

    return {
      toast: {
        type: 'success',
        content: `Recorded: ${approvalDecisionLabel(decision, approval.kind || 'tool')}.`,
      },
    };
  }

  async function onBotMenuEvent(event) {
    const eventKey = String(event?.event_key || '').trim();
    if (!eventKey) return;
    const openId = String(
      event?.operator?.operator_id?.open_id
      || event?.operator?.open_id
      || '',
    ).trim();
    if (!openId) return;

    const userPost = async (_channelId, _rootId, message) => {
      const msg = (message && typeof message === 'object' && message.markdown)
        ? String(message.markdown).trim()
        : String(message ?? '').trim();
      if (msg) {
        await feishu.sendPostMessageToUser({ openId, text: msg });
      }
    };

    const command = { command: eventKey, args: [], rawArgs: '' };
    try {
      const handled = await handleCommand({
        channelId: '',
        rootId: '',
        threadKey: '',
        approvalScopeKey: '',
        command,
        postMessage: userPost,
      });
      if (!handled) {
        await feishu.sendTextMessageToUser({ openId, text: `Unknown menu action: ${eventKey}` });
      }
    } catch (err) {
      await feishu.sendTextMessageToUser({ openId, text: `Menu action failed: ${String(err?.message || err)}` });
    }
  }

  async function onP2pEnteredEvent(event) {
    if (!config.feishuSendWelcomeOnP2pEnter) return;
    const chatId = String(event?.chat_id || '').trim();
    if (!chatId) return;
    await postMessage(chatId, '', 'Session ready. Send a message to begin.');
  }

  return async function onFeishuEvent(payload) {
    const eventType = String(payload?.header?.event_type || '').trim();
    if (!eventType) {
      return { code: 0, msg: 'ignored' };
    }

    if (eventType === 'card.action.trigger') {
      return onCardActionEvent(payload?.event || {});
    }

    if (!payload?.event) {
      return { code: 0, msg: 'ignored' };
    }

    if (eventType === 'im.message.receive_v1') {
      await onMessageEvent(payload.event);
      return { code: 0, msg: 'ok' };
    }

    if (eventType === 'application.bot.menu_v6') {
      await onBotMenuEvent(payload.event);
      return { code: 0, msg: 'ok' };
    }

    if (eventType === 'im.chat.access_event.bot_p2p_chat_entered_v1') {
      await onP2pEnteredEvent(payload.event);
      return { code: 0, msg: 'ok' };
    }

    return { code: 0, msg: 'ignored' };
  };
}
