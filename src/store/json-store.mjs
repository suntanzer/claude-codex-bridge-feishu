import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { newId } from '../util/ids.mjs';

function createDefaultState() {
  return {
    conversations: {},
    requests: {},
    approvals: {},
    runtime: {
      activeByRunner: {},
      queueByRunner: {},
    },
  };
}

export class JsonStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = createDefaultState();
    this._saveChain = Promise.resolve();
  }

  async load() {
    await mkdir(dirname(this.filePath), { recursive: true });
    if (!existsSync(this.filePath)) {
      await this.save();
      return;
    }
    const raw = await readFile(this.filePath, 'utf8');
    const parsed = JSON.parse(raw);
    this.state = {
      ...createDefaultState(),
      ...parsed,
      runtime: {
        ...createDefaultState().runtime,
        ...(parsed.runtime || {}),
      },
    };
  }

  async save() {
    this._saveChain = this._saveChain.catch(() => {}).then(async () => {
      const payload = JSON.stringify(this.state, null, 2);
      await mkdir(dirname(this.filePath), { recursive: true });
      const tmpPath = `${this.filePath}.${newId()}.tmp`;
      try {
        await writeFile(tmpPath, payload, 'utf8');
        await rename(tmpPath, this.filePath);
      } catch (error) {
        try { const { unlink } = await import('node:fs/promises'); await unlink(tmpPath); } catch {}
        throw error;
      }
    });
    return this._saveChain;
  }

  getConversation(key) { return this.state.conversations[key] ?? null; }
  listConversations() { return Object.entries(this.state.conversations).map(([key, value]) => ({ key, ...value })); }
  async setConversation(key, value) { this.state.conversations[key] = value; await this.save(); }
  async deleteConversation(key) { delete this.state.conversations[key]; await this.save(); }
  async patchConversation(key, patch) {
    const current = this.getConversation(key) ?? {};
    const next = { ...current, ...patch };
    this.state.conversations[key] = next;
    await this.save();
    return next;
  }

  getRequest(id) { return this.state.requests[id] ?? null; }
  listRequests() { return Object.values(this.state.requests); }
  async setRequest(id, value) { this.state.requests[id] = value; await this.save(); }
  async deleteRequest(id) { delete this.state.requests[id]; await this.save(); }
  async patchRequest(id, patch) {
    const current = this.getRequest(id) ?? {};
    const next = { ...current, ...patch };
    this.state.requests[id] = next;
    await this.save();
    return next;
  }

  getApproval(id) { return this.state.approvals[id] ?? null; }
  listApprovals() { return Object.values(this.state.approvals); }
  async setApproval(id, value) { this.state.approvals[id] = value; await this.save(); }
  async patchApproval(id, patch) {
    const current = this.getApproval(id) ?? {};
    const next = { ...current, ...patch };
    this.state.approvals[id] = next;
    await this.save();
    return next;
  }

  getRuntime() { return this.state.runtime; }
  async patchRuntime(patch) {
    this.state.runtime = {
      ...this.state.runtime,
      ...patch,
      activeByRunner: { ...this.state.runtime.activeByRunner, ...(patch.activeByRunner || {}) },
      queueByRunner: { ...this.state.runtime.queueByRunner, ...(patch.queueByRunner || {}) },
    };
    await this.save();
    return this.state.runtime;
  }
}
