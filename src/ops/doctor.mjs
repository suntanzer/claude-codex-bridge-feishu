import { formatAgeFromIso } from '../util/time.mjs';

function countByStatus(requests) {
  const counts = {};
  for (const request of requests) {
    counts[request.status] = (counts[request.status] || 0) + 1;
  }
  return counts;
}

function summarizeReconcile(summary) {
  if (!summary || summary.cancelled === 0) {
    return 'none';
  }
  return [
    `cancelled=${summary.cancelled}`,
    `queued=${summary.queued}`,
    `running=${summary.running}`,
    `waiting_approval=${summary.waitingApproval}`,
  ].join(' ');
}

function buildFields(entries) {
  return entries.map(([title, value, short = true]) => ({
    title,
    value: String(value || '(none)'),
    short,
  }));
}

export async function collectDoctorState({
  config,
  store,
  queue,
  runner,
  runnerKey,
  activeRequest,
  approvalStore,
  transportClient,
  callbackUrl,
  reconcileSummary,
}) {
  const inspection = await runner.inspect();
  const runtime = store.getRuntime();
  const requests = store.listRequests();
  const approvals = approvalStore.listPending();
  const active = activeRequest ? store.getRequest(activeRequest.requestId) : null;
  const queued = queue.list(runnerKey);
  const runtimeActive = runtime.activeByRunner?.[runnerKey] || '';
  const runtimeQueue = runtime.queueByRunner?.[runnerKey] || [];
  let transportStatus = 'unknown';
  try {
    await transportClient.getMe();
    transportStatus = 'ok';
  } catch (error) {
    transportStatus = `error: ${String(error?.message || error)}`;
  }

  return {
    config,
    callbackUrl,
    transportStatus,
    inspection,
    active,
    queued,
    approvals,
    requests,
    requestCounts: countByStatus(requests),
    runtimeActive,
    runtimeQueue,
    runtimeQueueMismatch:
      runtimeQueue.length !== queued.length ||
      runtimeQueue.some((requestId, index) => requestId !== queued[index]?.requestId),
    runtimeActiveMismatch: runtimeActive !== (active?.requestId || ''),
    reconcileSummary,
  };
}

export function renderDoctorReport(state) {
  const requestCounts = Object.entries(state.requestCounts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([status, count]) => `${status}=${count}`)
    .join(' ');

  const markdown = [
    'Doctor',
    `- transport: ${state.transportStatus}`,
    `- runner: ${state.config.bridgeRunner}`,
    `- runner idle: ${state.inspection.idle ? 'yes' : 'no'}`,
    `- waiting approval: ${state.inspection.waitingApproval ? 'yes' : 'no'}`,
    `- runner session: ${state.inspection.sessionId || '(none)'}`,
    `- callback: ${state.callbackUrl || '(disabled)'}`,
    `- data dir: ${state.config.dataDir}`,
    `- request retain days: ${state.config.requestRetainDays}`,
    `- active request: ${state.active?.requestId || '(none)'}`,
    `- active age: ${formatAgeFromIso(state.active?.startedAt || '')}`,
    `- queue size: ${state.queued.length}`,
    `- pending approvals: ${state.approvals.length}`,
    `- request counts: ${requestCounts || '(none)'}`,
    `- startup reconcile: ${summarizeReconcile(state.reconcileSummary)}`,
    `- runtime active mismatch: ${state.runtimeActiveMismatch ? 'yes' : 'no'}`,
    `- runtime queue mismatch: ${state.runtimeQueueMismatch ? 'yes' : 'no'}`,
  ].join('\n');

  return {
    markdown,
    attachments: [
      {
        color: state.transportStatus === 'ok' && !state.runtimeActiveMismatch && !state.runtimeQueueMismatch
          ? '#238636'
          : '#d29922',
        title: 'Doctor',
        fields: buildFields([
          ['Transport', state.transportStatus, false],
          ['Runner', state.config.bridgeRunner],
          ['Idle', state.inspection.idle ? 'yes' : 'no'],
          ['Waiting approval', state.inspection.waitingApproval ? 'yes' : 'no'],
          ['Queue', state.queued.length],
          ['Approvals', state.approvals.length],
          ['Runtime active mismatch', state.runtimeActiveMismatch ? 'yes' : 'no'],
          ['Runtime queue mismatch', state.runtimeQueueMismatch ? 'yes' : 'no'],
        ]),
      },
    ],
    card: [
      '### Doctor detail',
      '',
      markdown,
      '',
      '### Request counts',
      '',
      requestCounts || '(none)',
    ].join('\n'),
  };
}
