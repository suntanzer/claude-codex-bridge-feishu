import { loadConfig } from './config.mjs';
import { createLogger } from '../util/log.mjs';
import { JsonStore } from '../store/json-store.mjs';
import { ApprovalStore } from '../approval/store.mjs';
import { ApprovalService } from '../approval/service.mjs';
import { buildApprovalMessage } from '../approval/ui.mjs';
import { RequestQueue } from '../requests/queue.mjs';
import { RequestService } from '../requests/service.mjs';
import { FeishuClient } from '../transport/feishu-client.mjs';
import { startFeishuWebhookServer } from '../transport/feishu-webhook-server.mjs';
import { createFeishuEventHandler } from './feishu-event-handler.mjs';
import { createRequestExecutor } from './request-executor.mjs';
import { loadInstanceEnv } from './instance-env.mjs';
import { createRunner, runnerLabel } from '../runner/factory.mjs';
import { createOpsHandler } from '../ops/handler.mjs';
import { chunkText } from '../util/text.mjs';
import { buildApprovalCard, buildMarkdownReplyCard, shouldUseMarkdownCard } from '../transport/feishu-cards.mjs';

async function main() {
  await loadInstanceEnv();
  const config = await loadConfig();
  const logger = createLogger(`ccmm-feishu:${config.instanceName}`);
  const store = new JsonStore(config.storeFile);
  await store.load();

  const approvalStore = new ApprovalStore(store);
  const approvalService = new ApprovalService({ approvalStore });
  await approvalService.expireAll();

  const queue = new RequestQueue();
  const requestService = new RequestService({ store, queue });
  const reconcileSummary = await requestService.reconcileOnStartup();
  const prunedRequestCount = await requestService.pruneOldRequests(config.requestRetainDays);
  const prunedConversationCount = await requestService.pruneOldConversations(config.requestRetainDays);
  const runner = createRunner(config, logger.child('runner'));
  const feishu = new FeishuClient({
    appId: config.feishuAppId,
    appSecret: config.feishuAppSecret,
    logger: logger.child('feishu'),
  });

  const bootstrapOnly = process.env.CCMM_BOOTSTRAP_ONLY === 'true';
  if (bootstrapOnly) {
    logger.info(`bootstrap-only mode: runner=${config.bridgeRunner} dataDir=${config.dataDir}`);
    return;
  }

  await feishu.getMe();

  const callbackUrl = config.feishuPublicBaseUrl
    ? `${config.feishuPublicBaseUrl}${config.feishuCallbackPath}`
    : '';
  const runnerKey = config.bridgeRunner;
  const runnerName = runnerLabel(config.bridgeRunner);
  let activeRequest = null;
  const typingByRequest = new Map();

  if (reconcileSummary.cancelled > 0) {
    logger.warn(
      `startup reconciled stale requests: cancelled=${reconcileSummary.cancelled} queued=${reconcileSummary.queued} running=${reconcileSummary.running} waiting_approval=${reconcileSummary.waitingApproval}`,
    );
  }
  if (prunedRequestCount > 0) {
    logger.info(`startup pruned old requests: count=${prunedRequestCount} retainDays=${config.requestRetainDays}`);
  }
  if (prunedConversationCount > 0) {
    logger.info(`startup pruned old conversations: count=${prunedConversationCount} retainDays=${config.requestRetainDays}`);
  }
  logger.info(`feishu app ready: appId=${config.feishuAppId}`);
  await syncRuntime();

  async function syncRuntime() {
    await store.patchRuntime({
      activeByRunner: {
        [runnerKey]: activeRequest?.requestId || '',
      },
      queueByRunner: {
        [runnerKey]: queue.list(runnerKey).map((item) => item.requestId),
      },
    });
  }

  async function postMessage(chatId, rootId, message) {
    if (message && typeof message === 'object' && !Array.isArray(message) && message.card) {
      await feishu.postCard({
        chatId,
        replyToMessageId: rootId,
        card: message.card,
        replyInThread: Boolean(rootId),
      });
      return;
    }

    const text = String(message ?? '').trim();
    if (!text) {
      return;
    }

    const useCard = shouldUseMarkdownCard(text);
    const chunks = chunkText(text, useCard ? 3200 : 4000);
    for (const chunk of chunks) {
      if (useCard) {
        try {
          await feishu.postCard({
            chatId,
            replyToMessageId: rootId,
            card: buildMarkdownReplyCard(chunk),
            replyInThread: Boolean(rootId),
          });
        } catch (error) {
          logger.warn(`failed to post reply card, falling back to rich text: ${String(error?.message || error)}`);
          await feishu.postRichText({
            chatId,
            replyToMessageId: rootId,
            text: chunk,
            replyInThread: Boolean(rootId),
          });
        }
        continue;
      }

      await feishu.postRichText({
        chatId,
        replyToMessageId: rootId,
        text: chunk,
        replyInThread: Boolean(rootId),
      });
    }
  }

  async function sendTyping(sourceMessageId = '', requestId = '') {
    if (!sourceMessageId || !requestId || typingByRequest.has(requestId)) {
      return;
    }

    typingByRequest.set(requestId, {
      messageId: sourceMessageId,
      reactionId: '',
    });

    try {
      const reaction = await feishu.addTypingReaction({
        messageId: sourceMessageId,
      });
      typingByRequest.set(requestId, {
        messageId: sourceMessageId,
        reactionId: reaction.reactionId || '',
      });
    } catch (error) {
      logger.warn(`failed to add typing reaction: ${String(error?.message || error)}`);
    }
  }

  async function clearTyping(requestId = '') {
    if (!requestId) return;
    const typingState = typingByRequest.get(requestId);
    if (!typingState?.reactionId || !typingState?.messageId) {
      typingByRequest.delete(requestId);
      return;
    }

    try {
      await feishu.removeReaction({
        messageId: typingState.messageId,
        reactionId: typingState.reactionId,
      });
    } catch (error) {
      logger.warn(`failed to remove typing reaction: ${String(error?.message || error)}`);
    } finally {
      typingByRequest.delete(requestId);
    }
  }

  async function clearApprovalPost() {
    return undefined;
  }

  async function postApprovalPrompt(record) {
    try {
      await postMessage(record.channelId, record.rootId, {
        card: buildApprovalCard({
          approvalId: record.approvalId,
          runnerName,
          sessionId: record.sessionId || '',
          command: record.command,
          description: record.description,
          rootId: record.rootId,
          kind: record.kind || 'tool',
          message: record.message || '',
        }),
      });
    } catch (error) {
      logger.warn(`failed to post approval card, falling back to text: ${String(error?.message || error)}`);
      const message = buildApprovalMessage({
        runnerName,
        sessionId: record.sessionId || '',
        command: record.command,
        description: record.description,
        rootId: record.rootId,
        kind: record.kind || 'tool',
        message: record.message || '',
      });
      await postMessage(record.channelId, record.rootId, message);
    }
  }

  const { enqueueRequest } = createRequestExecutor({
    config,
    store,
    queue,
    runner,
    runnerKey,
    runnerName,
    requestService,
    approvalService,
    approvalStore,
    postMessage,
    postApprovalPrompt,
    sendTyping,
    clearTyping,
    getActiveRequest: () => activeRequest,
    setActiveRequest: (value) => {
      activeRequest = value;
    },
    syncRuntime,
  });

  const handleCommand = createOpsHandler({
    config,
    store,
    queue,
    runner,
    runnerKey,
    approvalStore,
    approvalService,
    transportClient: feishu,
    callbackUrl,
    reconcileSummary,
    getActiveRequest: () => activeRequest,
    postMessage,
    postApprovalPrompt,
  });

  async function handleResolvedApproval(approval, decision, meta = {}) {
    await clearApprovalPost(approval, decision, meta);
    if (!approval || approval.kind !== 'checkpoint') {
      return;
    }
    if (!['confirm', 'skip', 'revise'].includes(decision)) {
      return;
    }
    await enqueueRequest({
      threadKey: approval.conversationThreadKey || approval.threadKey,
      approvalScopeKey: approval.threadKey,
      channelId: approval.channelId,
      rootId: approval.rootId,
      prompt: decision,
      userId: approval.requestedByUserId || '',
    });
  }

  const onEvent = createFeishuEventHandler({
    config,
    store,
    approvalStore,
    approvalService,
    onResolvedApproval: handleResolvedApproval,
    handleCommand,
    enqueueRequest,
    postMessage,
  });

  startFeishuWebhookServer({
    logger: logger.child('webhook'),
    listenHost: config.feishuCallbackListenHost,
    port: config.feishuCallbackPort,
    path: config.feishuCallbackPath,
    encryptKey: config.feishuEncryptKey,
    verificationToken: config.feishuVerificationToken,
    onEvent,
  });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.warn(`shutting down (${signal})`);
    await approvalService.denyAll();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  logger.info(`callback URL: ${callbackUrl || '(local only)'}`);
}

main().catch((error) => {
  console.error(`[ccmm-feishu] fatal: ${error?.stack || error}`);
  process.exit(1);
});
