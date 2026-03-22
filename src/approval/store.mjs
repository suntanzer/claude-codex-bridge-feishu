export class ApprovalStore {
  constructor(store) {
    this.store = store;
  }

  async create(record) {
    await this.store.setApproval(record.approvalId, record);
    return record;
  }

  async update(approvalId, patch) {
    return this.store.patchApproval(approvalId, patch);
  }

  get(approvalId) {
    return this.store.getApproval(approvalId);
  }

  listPending() {
    return this.store.listApprovals().filter((item) => item.status === 'pending');
  }
}
