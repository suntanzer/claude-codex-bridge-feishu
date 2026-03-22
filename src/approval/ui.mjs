import { approvalDecisionLabel } from './decisions.mjs';

export function buildApprovalProps({ callbackUrl, approvalId, channelId, runnerName, kind = 'tool' }) {
  if (!callbackUrl) return undefined;
  const actions = kind === 'checkpoint'
    ? [
        {
          id: 'confirm',
          name: 'Confirm',
          type: 'button',
          style: 'primary',
          integration: {
            url: callbackUrl,
            context: { approval_id: approvalId, decision: 'confirm', channel_id: channelId },
          },
        },
        {
          id: 'skip',
          name: 'Skip',
          type: 'button',
          integration: {
            url: callbackUrl,
            context: { approval_id: approvalId, decision: 'skip', channel_id: channelId },
          },
        },
        {
          id: 'revise',
          name: 'Revise',
          type: 'button',
          integration: {
            url: callbackUrl,
            context: { approval_id: approvalId, decision: 'revise', channel_id: channelId },
          },
        },
        {
          id: 'comment',
          name: 'Comment',
          type: 'button',
          integration: {
            url: callbackUrl,
            context: { approval_id: approvalId, decision: 'comment', channel_id: channelId },
          },
        },
      ]
    : [
        {
          id: 'approveonce',
          name: 'Approve once',
          type: 'button',
          style: 'primary',
          integration: {
            url: callbackUrl,
            context: { approval_id: approvalId, decision: 'approve_once', channel_id: channelId },
          },
        },
        {
          id: 'approvealways',
          name: 'Approve + remember',
          type: 'button',
          integration: {
            url: callbackUrl,
            context: { approval_id: approvalId, decision: 'approve_always', channel_id: channelId },
          },
        },
        {
          id: 'reject',
          name: 'Reject',
          type: 'button',
          style: 'danger',
          integration: {
            url: callbackUrl,
            context: { approval_id: approvalId, decision: 'reject', channel_id: channelId },
          },
        },
      ];
  return {
    attachments: [
      {
        text: kind === 'checkpoint'
          ? `Choose how to continue this ${runnerName} checkpoint.`
          : `Choose how to handle this ${runnerName} permission request.`,
        actions,
      },
    ],
  };
}

export function buildApprovalMessage({ runnerName, sessionId, command, description, rootId, kind = 'tool', message = '' }) {
  if (kind === 'checkpoint') {
    return [
      message,
      ' ',
      rootId
        ? 'Fallback: reply `confirm`, `skip`, `revise`, or `comment` in this thread.'
        : 'Fallback: reply `confirm`, `skip`, `revise`, or `comment` in this channel.',
    ].filter(line => line !== undefined && line !== '').join('\n');
  }

  return [
    `${runnerName} is waiting for approval.`,
    sessionId ? `- session: \`${sessionId}\`` : '',
    command ? `- command: \`${command}\`` : '',
    description ? `- note: ${description}` : '',
    ' ',
    'Choose one:',
    '- Approve once',
    '- Approve + remember',
    '- Reject',
    ' ',
    rootId ? 'Fallback: reply `1`, `2`, or `3` in this thread.' : 'Fallback: reply `1`, `2`, or `3` in this channel.',
  ].filter(line => line !== undefined).join('\n');
}

export function buildApprovalCallbackResponse({ decision, userName, kind = 'tool' }) {
  return {
    update: {
      message:
        kind === 'checkpoint'
          ? `Checkpoint: ${approvalDecisionLabel(decision, kind)} by @${userName || 'unknown'}`
          : `Authorization: ${approvalDecisionLabel(decision, kind)} by @${userName || 'unknown'}`,
      props: { attachments: [] },
    },
    ephemeral_text: `Recorded: ${approvalDecisionLabel(decision, kind)}`,
  };
}
