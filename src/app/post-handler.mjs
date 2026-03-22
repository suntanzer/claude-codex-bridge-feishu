import { approvalDecisionLabel, normalizeApprovalDecision } from '../approval/decisions.mjs';
import { isDirectMessage, makeChannelApprovalKey, makeThreadKey, parseCommand } from '../transport/routing.mjs';

function pickApprovalForScope({ approvalService, threadKey, channelId, isThreaded }) {
  if (isThreaded) {
    return approvalService.findByThread(threadKey);
  }
  return approvalService.findByChannel(channelId);
}

export function createPostHandler({
  config,
  store,
  me,
  approvalService,
  onResolvedApproval,
  handleCommand,
  enqueueRequest,
  postMessage,
}) {
  return async function onPost(post, payload) {
    if (!post || post.user_id === me.id) return;
    if (post.type) return;
    if (post.props?.from_bot === true || post.props?.from_bot === 'true') return;

    const channelId = post.channel_id;
    const isDm = isDirectMessage(payload);
    if (config.allowedChannels.length > 0 && !config.allowedChannels.includes(channelId)) {
      return;
    }
    if (!isDm && config.allowedChannels.length === 0) {
      return;
    }
    if (config.allowedUsers.length > 0 && !config.allowedUsers.includes(post.user_id)) {
      return;
    }

    const message = String(post.message || '').trim();
    if (!message) return;

    const replyRootId = isDm ? '' : (post.root_id || post.id);
    const conversationRootId = isDm ? channelId : (post.root_id || post.id);
    const threadKey = makeThreadKey(channelId, conversationRootId);
    const approvalScopeKey = isDm ? makeChannelApprovalKey(channelId) : threadKey;
    const conversation = store.getConversation(threadKey) || {
      key: threadKey,
      channelId,
      rootId: replyRootId,
      userId: post.user_id,
      cwd: config.defaultCwd,
      model: '',
      sessionId: '',
      updatedAt: Date.now(),
    };

    const pendingApprovalForDecision = pickApprovalForScope({
      approvalService,
      threadKey: approvalScopeKey,
      channelId,
      isThreaded: !isDm,
    });
    const approvalDecision = normalizeApprovalDecision(message, pendingApprovalForDecision?.kind || 'tool');
    const pendingApproval = approvalDecision
      ? pendingApprovalForDecision
      : null;
    if (approvalDecision && pendingApproval) {
      await approvalService.resolveApproval(pendingApproval.approvalId, approvalDecision, {
        via: 'text',
        userId: post.user_id,
        userName: post.user_id,
      });
      await onResolvedApproval?.(pendingApproval, approvalDecision, {
        via: 'text',
        userId: post.user_id,
        userName: post.user_id,
      });
      if (pendingApproval.kind === 'checkpoint') {
        if (['confirm', 'skip', 'revise'].includes(approvalDecision)) {
          await enqueueRequest({
            threadKey: pendingApproval.conversationThreadKey || threadKey,
            approvalScopeKey,
            channelId,
            rootId: replyRootId,
            prompt: approvalDecision,
            userId: post.user_id,
          });
        }
      } else {
        await postMessage(channelId, replyRootId, `Authorization recorded: ${approvalDecisionLabel(approvalDecision)}.`);
      }
      return;
    }

    const command = parseCommand(message, config.commandPrefix);
    if (command) {
      const handled = await handleCommand({
        channelId,
        rootId: replyRootId,
        threadKey,
        approvalScopeKey,
        command,
        conversation,
      });
      if (handled) return;
    }

    await store.patchConversation(threadKey, {
      ...conversation,
      updatedAt: Date.now(),
    });
    await enqueueRequest({
      threadKey,
      approvalScopeKey,
      channelId,
      rootId: replyRootId,
      prompt: message,
      userId: post.user_id,
    });
  };
}
