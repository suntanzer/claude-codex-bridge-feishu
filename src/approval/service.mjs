import { newId } from '../util/ids.mjs';
import { nowMs, nowIso } from '../util/time.mjs';

export class ApprovalService {
  constructor({ approvalStore, ttlMs = 10 * 60_000 }) {
    this.approvalStore = approvalStore;
    this.ttlMs = ttlMs;
    this.pending = new Map();
  }

  async createApproval({
    requestId,
    threadKey,
    conversationThreadKey = '',
    channelId,
    rootId = '',
    kind = 'tool',
    command = '',
    description = '',
    message = '',
    requestedByUserId = '',
    sessionId = '',
  }) {
    const approvalId = newId();
    const createdAt = nowIso();
    const expiresAtMs = nowMs() + this.ttlMs;
    const record = {
      approvalId,
      requestId,
      threadKey,
      conversationThreadKey,
      channelId,
      rootId,
      kind,
      command,
      description,
      message,
      requestedByUserId,
      sessionId,
      status: 'pending',
      createdAt,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
    await this.approvalStore.create(record);

    const completion = new Promise((resolve) => {
      const timeout = setTimeout(async () => {
        await this.resolveApproval(approvalId, 'expired', { via: 'timeout', userName: 'timeout' });
        resolve({ decision: 'expired', via: 'timeout', userName: 'timeout' });
      }, this.ttlMs);
      this.pending.set(approvalId, { resolve, timeout, record });
    });

    return { approvalId, record, completion };
  }

  async resolveApproval(approvalId, decision, meta = {}) {
    const pending = this.pending.get(approvalId);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pending.delete(approvalId);
      pending.resolve({ decision, ...meta });
    }
    await this.approvalStore.update(approvalId, {
      status: decision === 'expired' ? 'expired' : 'resolved',
      resolvedAt: nowIso(),
      resolvedDecision: decision,
      ...meta,
    });
    return true;
  }

  async expireAll() {
    const pending = this.approvalStore.listPending();
    for (const approval of pending) {
      await this.approvalStore.update(approval.approvalId, {
        status: 'expired',
        resolvedAt: nowIso(),
        resolvedDecision: 'expired',
        via: 'startup-expire',
      });
    }
  }

  async denyAll() {
    const ids = [...this.pending.keys()];
    for (const approvalId of ids) {
      await this.resolveApproval(approvalId, 'reject', { via: 'shutdown', userName: 'bridge' });
    }
  }

  findByThread(threadKey) {
    return this.approvalStore.listPending().find((item) => item.threadKey === threadKey) || null;
  }

  findByChannel(channelId) {
    return this.approvalStore.listPending().find((item) => item.channelId === channelId && !item.rootId) || null;
  }
}
