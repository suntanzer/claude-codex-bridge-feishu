import { formatElapsed } from '../util/time.mjs';
import { buildFailureCard, buildProgressCard, buildQueueCard } from '../transport/feishu-cards.mjs';

function extractInterimMessage(event) {
  if (!event || typeof event !== 'object') return '';

  if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
    const text = typeof event.item?.text === 'string' ? event.item.text.trim() : '';
    if (text) return text;
    const content = Array.isArray(event.item?.content) ? event.item.content : [];
    const parts = content
      .map((part) => (typeof part?.text === 'string' ? part.text : ''))
      .filter(Boolean);
    return parts.join('\n').trim();
  }

  if (event.type === 'assistant' && event.message?.role === 'assistant') {
    const content = Array.isArray(event.message?.content) ? event.message.content : [];
    const parts = content
      .map((part) => (typeof part?.text === 'string' ? part.text : ''))
      .filter(Boolean);
    return parts.join('\n').trim();
  }

  if (event.type === 'event_msg' && event.payload?.type === 'agent_message') {
    const text = typeof event.payload?.message === 'string' ? event.payload.message.trim() : '';
    return text;
  }

  if (event.type === 'response_item' && event.payload?.type === 'message' && event.payload?.role === 'assistant' && event.payload?.phase === 'commentary') {
    const content = Array.isArray(event.payload?.content) ? event.payload.content : [];
    const parts = content
      .map((part) => (part?.type === 'output_text' && typeof part?.text === 'string' ? part.text : ''))
      .filter(Boolean);
    return parts.join('\n').trim();
  }

  return '';
}

function normalizeAssistantText(text) {
  return typeof text === 'string' ? text.trim() : '';
}

/**
 * Extract a checkpoint block from assistant text.
 *
 * The model sometimes prepends analysis/discussion before the checkpoint block.
 * Instead of requiring the entire message to start with "Checkpoint", we search
 * for a line starting with "Checkpoint" anywhere in the text and validate the
 * structured markers from that line onward.
 *
 * Returns the full message text when a valid checkpoint is found, null otherwise.
 */
function extractCodexCheckpoint(text) {
  const normalized = normalizeAssistantText(text);
  if (!normalized) return null;

  const lines = normalized.split('\n');
  let cpStartIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().toLowerCase().startsWith('checkpoint')) {
      cpStartIdx = i;
      break;
    }
  }
  if (cpStartIdx < 0) return null;

  const cpText = lines.slice(cpStartIdx).join('\n');
  const cpLower = cpText.toLowerCase();

  const hasDecisionCues =
    cpLower.includes('reply "confirm"') &&
    cpLower.includes('reply "skip"') &&
    cpLower.includes('reply "revise"');
  if (hasDecisionCues) return normalized;

  const structuredMarkers = [
    '- action:',
    '- scope:',
    '- why:',
    '- exact command',
    '- expected effect:',
    '- rollback/risk:',
    '- reversible:',
  ];
  const hitCount = structuredMarkers.filter((marker) => cpLower.includes(marker)).length;
  if (hitCount >= 4) return normalized;

  return null;
}

export function createRequestExecutor({
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
  getActiveRequest,
  setActiveRequest,
  syncRuntime,
}) {
  async function updateConversationSession({ threadKey, channelId, rootId, userId, sessionId }) {
    if (!sessionId) return;
    const conversation = store.getConversation(threadKey) || {};
    await store.patchConversation(threadKey, {
      ...conversation,
      channelId,
      rootId,
      userId,
      updatedAt: Date.now(),
      runner: config.bridgeRunner,
      sessionId,
    });
  }

  let runnerBusy = false;

  async function runNextRequest() {
    if (getActiveRequest() || runnerBusy) {
      return;
    }
    runnerBusy = true;
    const next = queue.dequeue(runnerKey);
    await syncRuntime();
    if (!next) {
      runnerBusy = false;
      return;
    }

    setActiveRequest(next);
    await syncRuntime();
    await requestService.markRunning(next.requestId, {
      sessionId: next.sessionId || '',
    });

    const conversation = store.getConversation(next.threadKey) || {};
    const resumeSessionId = conversation.runner === config.bridgeRunner
      ? (conversation.sessionId || '')
      : '';
    let lastSeenSessionId = resumeSessionId;
    let waitingApproval = false;
    let lastProgressAt = Date.now();
    let lastInterimAt = 0;
    let lastInterimText = '';
    let checkpointText = '';
    const ctx = {
      prompt: next.prompt,
      cwd: conversation.cwd || config.defaultCwd,
      sessionId: resumeSessionId,
      model: conversation.model || '',
      profile: config.codexProfile || '',
      threadKey: next.threadKey,
    };

    const typingLoop = setInterval(() => {
      if (waitingApproval) return;
      void sendTyping(next.sourceMessageId, next.requestId);
    }, config.typingIntervalMs);

    try {
      await sendTyping(next.sourceMessageId, next.requestId);
      const result = await runner.run(ctx, {
        onHeartbeat: async ({ sessionId = '', waitingApproval: runnerWaitingApproval = false }) => {
          waitingApproval = runnerWaitingApproval;
          await requestService.markHeartbeat(next.requestId);
          if (!waitingApproval) {
            void sendTyping(next.sourceMessageId, next.requestId);
          }
          if ((Date.now() - lastProgressAt) >= config.progressMessageMs) {
            const request = store.getRequest(next.requestId);
            const elapsed = request?.startedAt
              ? formatElapsed(Date.now() - Date.parse(request.startedAt))
              : '0m0s';
            await postMessage(
              next.channelId,
              next.rootId,
              {
                card: buildProgressCard({
                  runnerName,
                  sessionId,
                  elapsed,
                  requestId: next.requestId,
                  waitingApproval,
                }),
              },
            );
            lastProgressAt = Date.now();
          }
        },
        requestApproval: async ({ sessionId = '', command = '', description = '' }) => {
          waitingApproval = true;
          const { record, completion } = await approvalService.createApproval({
            requestId: next.requestId,
            threadKey: next.approvalScopeKey,
            conversationThreadKey: next.threadKey,
            channelId: next.channelId,
            rootId: next.rootId,
            command,
            description,
            requestedByUserId: next.userId,
          });
          await approvalStore.update(record.approvalId, { sessionId });
          await requestService.markWaitingApproval(next.requestId, {
            sessionId,
            currentApprovalId: record.approvalId,
            diagnostics: {
              command,
              description,
            },
          });
          await postApprovalPrompt(record);
          const resolution = await completion;
          waitingApproval = false;
          lastProgressAt = Date.now();
          if (resolution.decision === 'approve_once' || resolution.decision === 'approve_always') {
            await requestService.markRunning(next.requestId, { sessionId });
          }
          return resolution.decision;
        },
        onEvent: async (_event, state = {}) => {
          if (state.sessionId && state.sessionId !== lastSeenSessionId) {
            lastSeenSessionId = state.sessionId;
            await updateConversationSession({
              threadKey: next.threadKey,
              channelId: next.channelId,
              rootId: next.rootId,
              userId: next.userId,
              sessionId: state.sessionId,
            });
          }

          const interimText = extractInterimMessage(_event);
          const normalizedInterimText = normalizeAssistantText(interimText);
          const interimCheckpoint = runnerKey === 'codex' ? extractCodexCheckpoint(normalizedInterimText) : null;
          if (interimCheckpoint) {
            checkpointText = interimCheckpoint;
            return;
          }
          if (normalizedInterimText && normalizedInterimText !== lastInterimText && (Date.now() - lastInterimAt) >= 2000) {
            lastInterimText = normalizedInterimText;
            lastInterimAt = Date.now();
            await postMessage(next.channelId, next.rootId, normalizedInterimText);
          }
        },
      });

      await updateConversationSession({
        threadKey: next.threadKey,
        channelId: next.channelId,
        rootId: next.rootId,
        userId: next.userId,
        sessionId: result.sessionId,
      });

      if (result.ok) {
        await requestService.markCompleted(next.requestId, {
          sessionId: result.sessionId || '',
          diagnostics: result.diagnostics || {},
        });
        const normalizedFinalText = normalizeAssistantText(result.finalText);
        const finalCheckpointText =
          (runnerKey === 'codex' ? extractCodexCheckpoint(normalizedFinalText) : null)
          || checkpointText;
        if (finalCheckpointText) {
          const { record } = await approvalService.createApproval({
            requestId: next.requestId,
            threadKey: next.approvalScopeKey,
            conversationThreadKey: next.threadKey,
            channelId: next.channelId,
            rootId: next.rootId,
            kind: 'checkpoint',
            message: finalCheckpointText,
            requestedByUserId: next.userId,
            sessionId: result.sessionId || '',
          });
          await postApprovalPrompt(record);
        } else if (!normalizedFinalText) {
          if (!lastInterimText) {
            await postMessage(next.channelId, next.rootId, '(no output)');
          }
        } else if (normalizedFinalText !== lastInterimText) {
          await postMessage(next.channelId, next.rootId, normalizedFinalText);
        }
      } else {
        await requestService.markFailed(next.requestId, {
          sessionId: result.sessionId || '',
          diagnostics: result.diagnostics || {},
        });
        const stderr = Array.isArray(result?.diagnostics?.stderr) ? result.diagnostics.stderr.slice(-8).join('\n') : '';
        const details = stderr || JSON.stringify(result.diagnostics || {}, null, 2);
        await postMessage(
          next.channelId,
          next.rootId,
          {
            card: buildFailureCard({
              runnerName,
              reason: result.reason || 'failed',
              code: result.code,
              signal: result.signal || 'none',
              details,
            }),
          },
        );
      }
    } catch (error) {
      await requestService.markFailed(next.requestId, {
        diagnostics: { error: String(error?.message || error) },
      });
      await postMessage(
        next.channelId,
        next.rootId,
        `${runnerName} run failed before completion.\n\n${String(error?.message || error)}`,
      );
    } finally {
      clearInterval(typingLoop);
      await clearTyping(next.requestId);
      setActiveRequest(null);
      runnerBusy = false;
      await syncRuntime();
      setImmediate(() => {
        void runNextRequest();
      });
    }
  }

  async function enqueueRequest({ threadKey, approvalScopeKey, channelId, rootId, sourceMessageId = '', prompt, userId }) {
    const request = await requestService.createRequest({
      threadKey,
      approvalScopeKey,
      runner: config.bridgeRunner,
      prompt,
      channelId,
      rootId,
      sourceMessageId,
      userId,
    });
    queue.enqueue(runnerKey, request);
    await syncRuntime();
    const activeRequest = getActiveRequest();
    if (activeRequest) {
      const position = queue.size(runnerKey);
      await postMessage(
        channelId,
        rootId,
        {
          card: buildQueueCard({
            runnerName,
            position,
            activeRequestId: activeRequest.requestId,
          }),
        },
      );
      return;
    }
    setImmediate(() => {
      void runNextRequest();
    });
  }

  return {
    enqueueRequest,
    runNextRequest,
  };
}
