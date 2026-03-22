import { RunnerAdapter } from './base.mjs';

export class ClaudeTmuxRunner extends RunnerAdapter {
  constructor({ logger, tmuxSessionName }) {
    super();
    this.logger = logger;
    this.tmuxSessionName = tmuxSessionName;
  }

  async inspect() {
    return {
      idle: true,
      waitingApproval: false,
      sessionId: '',
      deprecated: true,
    };
  }

  async run() {
    throw new Error('claude-tmux is deprecated in ccmm and is not implemented in the first coding slice.');
  }

  async cancel() {
    return false;
  }
}
