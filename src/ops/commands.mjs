import { formatAgeFromIso, formatElapsed, nowMs } from '../util/time.mjs';

function summarizeCounts(requests) {
  const counts = {};
  for (const request of requests || []) {
    counts[request.status] = (counts[request.status] || 0) + 1;
  }
  return Object.entries(counts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([status, count]) => `${status}=${count}`)
    .join(' ');
}

function buildFields(entries) {
  return entries.map(([title, value, short = true]) => ({
    title,
    value: String(value || '(none)'),
    short,
  }));
}

export function renderStatus({ config, runtime, approvals, queue, runnerKey, requests, activeRequestId }) {
  const requestCounts = summarizeCounts(requests) || '(none)';
  const markdown = [
    'Bridge status',
    `- runner: ${config.bridgeRunner}`,
    `- channels: ${config.allowedChannels.join(', ') || '(none)'}`,
    `- active request: ${activeRequestId || '(none)'}`,
    `- queue size: ${queue.size(runnerKey)}`,
    `- pending approvals: ${approvals.length}`,
    `- request counts: ${requestCounts}`,
    `- runtime active slot: ${runtime.activeByRunner?.[runnerKey] || '(none)'}`,
  ].join('\n');
  return {
    markdown,
    attachments: [
      {
        color: '#2f81f7',
        title: 'Bridge status',
        fields: buildFields([
          ['Runner', config.bridgeRunner],
          ['Queue', queue.size(runnerKey)],
          ['Approvals', approvals.length],
          ['Active request', activeRequestId || '(none)', false],
          ['Runtime active', runtime.activeByRunner?.[runnerKey] || '(none)', false],
          ['Requests', requestCounts, false],
        ]),
      },
    ],
  };
}

export function renderQueue({ queue, runnerKey }) {
  const items = queue.list(runnerKey);
  if (items.length === 0) {
    return 'Queue is empty.';
  }
  return [
    'Queue',
    ...items.map((item, index) => `- ${index + 1}. ${item.requestId} (${item.threadKey}) age=${formatAgeFromIso(item.createdAt)}`),
  ].join('\n');
}

export function renderCurrent({ request }) {
  if (!request) return 'No active request.';
  const started = request.startedAt ? Date.parse(request.startedAt) : 0;
  const elapsed = started ? formatElapsed(nowMs() - started) : '0m0s';
  const markdown = [
    'Current request',
    `- request: ${request.requestId}`,
    `- status: ${request.status}`,
    `- runner: ${request.runner}`,
    `- session: ${request.sessionId || '(none)'}`,
    `- elapsed: ${elapsed}`,
    `- last heartbeat: ${formatAgeFromIso(request.lastHeartbeatAt)}`,
    `- approval: ${request.currentApprovalId || '(none)'}`,
    `- thread: ${request.threadKey}`,
  ].join('\n');
  return {
    markdown,
    attachments: [
      {
        color: '#8250df',
        title: 'Current request',
        fields: buildFields([
          ['Status', request.status],
          ['Runner', request.runner],
          ['Elapsed', elapsed],
          ['Session', request.sessionId || '(none)', false],
          ['Approval', request.currentApprovalId || '(none)', false],
        ]),
      },
    ],
  };
}
