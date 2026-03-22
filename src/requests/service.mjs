import { newId } from '../util/ids.mjs';
import { nowIso, parseIsoMs } from '../util/time.mjs';

export class RequestService {
  constructor({ store, queue }) {
    this.store = store;
    this.queue = queue;
  }

  async createRequest({
    threadKey,
    approvalScopeKey = '',
    runner,
    prompt,
    channelId,
    rootId = '',
    sourceMessageId = '',
    userId = '',
  }) {
    const requestId = newId();
    const record = {
      requestId,
      threadKey,
      approvalScopeKey,
      runner,
      channelId,
      rootId,
      sourceMessageId,
      userId,
      prompt,
      status: 'queued',
      createdAt: nowIso(),
      startedAt: '',
      completedAt: '',
      heartbeatCount: 0,
      lastHeartbeatAt: '',
      approvalPauseMs: 0,
      sessionId: '',
      currentApprovalId: '',
      diagnostics: {},
    };
    await this.store.setRequest(requestId, record);
    return record;
  }

  async markRunning(requestId, patch = {}) {
    const current = this.store.getRequest(requestId) || {};
    return this.store.patchRequest(requestId, {
      status: 'running',
      startedAt: current.startedAt || nowIso(),
      currentApprovalId: '',
      ...patch,
    });
  }

  async markWaitingApproval(requestId, patch = {}) {
    return this.store.patchRequest(requestId, { status: 'waiting_approval', ...patch });
  }

  async markHeartbeat(requestId) {
    const current = this.store.getRequest(requestId) || {};
    return this.store.patchRequest(requestId, {
      heartbeatCount: (current.heartbeatCount || 0) + 1,
      lastHeartbeatAt: nowIso(),
    });
  }

  async markCompleted(requestId, patch = {}) {
    return this.store.patchRequest(requestId, {
      status: 'completed',
      completedAt: nowIso(),
      currentApprovalId: '',
      ...patch,
    });
  }

  async markFailed(requestId, patch = {}) {
    return this.store.patchRequest(requestId, {
      status: 'failed',
      completedAt: nowIso(),
      currentApprovalId: '',
      ...patch,
    });
  }

  async markCancelled(requestId, patch = {}) {
    return this.store.patchRequest(requestId, {
      status: 'cancelled',
      completedAt: nowIso(),
      currentApprovalId: '',
      ...patch,
    });
  }

  async reconcileOnStartup(reason = 'bridge_restart') {
    const requests = this.store.listRequests();
    const summary = {
      queued: 0,
      running: 0,
      waitingApproval: 0,
      cancelled: 0,
    };

    for (const request of requests) {
      if (request.status === 'queued') {
        summary.queued += 1;
      } else if (request.status === 'running') {
        summary.running += 1;
      } else if (request.status === 'waiting_approval') {
        summary.waitingApproval += 1;
      } else {
        continue;
      }

      await this.markCancelled(request.requestId, {
        diagnostics: {
          ...(request.diagnostics || {}),
          reconcileReason: reason,
          previousStatus: request.status,
        },
      });
      summary.cancelled += 1;
    }

    return summary;
  }

  async pruneOldRequests(maxAgeDays = 7) {
    const cutoffMs = Date.now() - (maxAgeDays * 86_400_000);
    let pruned = 0;
    for (const request of this.store.listRequests()) {
      if (!['completed', 'failed', 'cancelled'].includes(request.status)) {
        continue;
      }
      const finishedAt = parseIsoMs(request.completedAt);
      if (!finishedAt || finishedAt >= cutoffMs) {
        continue;
      }
      await this.store.deleteRequest(request.requestId);
      pruned += 1;
    }
    return pruned;
  }

  async pruneOldConversations(maxAgeDays = 7) {
    const cutoffMs = Date.now() - (maxAgeDays * 86_400_000);
    const activeConversationKeys = new Set(
      this.store.listRequests()
        .filter((request) => !['completed', 'failed', 'cancelled'].includes(request.status))
        .map((request) => request.threadKey)
        .filter(Boolean),
    );

    let pruned = 0;
    for (const conversation of this.store.listConversations()) {
      if (activeConversationKeys.has(conversation.key)) {
        continue;
      }
      const updatedAtMs = Number(conversation.updatedAt || 0);
      if (!updatedAtMs || updatedAtMs >= cutoffMs) {
        continue;
      }
      await this.store.deleteConversation(conversation.key);
      pruned += 1;
    }
    return pruned;
  }
}
