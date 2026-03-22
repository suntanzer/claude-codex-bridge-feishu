export class RunnerAdapter {
  async inspect() {
    throw new Error('inspect() not implemented');
  }

  // run() should return:
  // { sessionId, finalText, ok, code, signal, reason, diagnostics }
  async run(_ctx, _callbacks) {
    throw new Error('run() not implemented');
  }

  async cancel() {
    throw new Error('cancel() not implemented');
  }
}
