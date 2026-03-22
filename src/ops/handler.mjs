import { renderCurrent, renderQueue, renderStatus } from './commands.mjs';
import { collectDoctorState, renderDoctorReport } from './doctor.mjs';

export function createOpsHandler({
  config,
  store,
  queue,
  runner,
  runnerKey,
  approvalStore,
  approvalService,
  transportClient,
  callbackUrl = '',
  reconcileSummary,
  getActiveRequest,
  postMessage,
  postApprovalPrompt,
}) {
  return async function handleCommand({ channelId, rootId, threadKey, approvalScopeKey, command, postMessage: postOverride }) {
    const post = postOverride || postMessage;
    if (command.command === 'help') {
      await post(
        channelId,
        rootId,
        [
          'ccmm bridge commands',
          `- ${config.commandPrefix} status`,
          `- ${config.commandPrefix} doctor`,
          `- ${config.commandPrefix} queue`,
          `- ${config.commandPrefix} current`,
          `- ${config.commandPrefix} cancel`,
          `- ${config.commandPrefix} rescue`,
        ].join('\n'),
      );
      return true;
    }

    if (command.command === 'status') {
      await post(
        channelId,
        rootId,
        renderStatus({
          config,
          runtime: store.getRuntime(),
          approvals: approvalStore.listPending(),
          queue,
          runnerKey,
          requests: store.listRequests(),
          activeRequestId: getActiveRequest()?.requestId || '',
        }),
      );
      return true;
    }

    if (command.command === 'queue') {
      await post(channelId, rootId, renderQueue({ queue, runnerKey }));
      return true;
    }

    if (command.command === 'current') {
      const activeRequest = getActiveRequest();
      const current = activeRequest ? store.getRequest(activeRequest.requestId) : null;
      await post(channelId, rootId, renderCurrent({ request: current }));
      return true;
    }

    if (command.command === 'doctor') {
      const doctorState = await collectDoctorState({
        config,
        store,
        queue,
        runner,
        runnerKey,
        activeRequest: getActiveRequest(),
        approvalStore,
        transportClient,
        callbackUrl,
        reconcileSummary,
      });
      await post(channelId, rootId, renderDoctorReport(doctorState));
      return true;
    }

    if (command.command === 'cancel') {
      const cancelled = await runner.cancel();
      await post(channelId, rootId, cancelled ? 'Cancel requested.' : 'No active runner task to cancel.');
      return true;
    }

    if (command.command === 'rescue') {
      const approval =
        approvalService.findByThread(approvalScopeKey) ||
        approvalService.findByThread(threadKey) ||
        approvalService.findByChannel(channelId);
      if (!approval) {
        await post(channelId, rootId, 'No pending approval found for this scope.');
        return true;
      }
      await postApprovalPrompt(approval);
      await post(channelId, rootId, 'Reposted the pending approval prompt.');
      return true;
    }

    return false;
  };
}
