export class RequestQueue {
  constructor() {
    this.queueByRunner = new Map();
  }

  enqueue(runnerKey, request) {
    const queue = this.queueByRunner.get(runnerKey) || [];
    queue.push(request);
    this.queueByRunner.set(runnerKey, queue);
    return queue.length;
  }

  dequeue(runnerKey) {
    const queue = this.queueByRunner.get(runnerKey) || [];
    const item = queue.shift() || null;
    this.queueByRunner.set(runnerKey, queue);
    return item;
  }

  peek(runnerKey) {
    const queue = this.queueByRunner.get(runnerKey) || [];
    return queue[0] || null;
  }

  list(runnerKey) {
    return [...(this.queueByRunner.get(runnerKey) || [])];
  }

  size(runnerKey) {
    return (this.queueByRunner.get(runnerKey) || []).length;
  }
}
