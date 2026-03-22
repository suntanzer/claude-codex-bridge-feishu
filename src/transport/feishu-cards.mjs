function truncate(value, max = 1200) {
  const text = String(value || '').trim();
  if (!text || text.length <= max) return text;
  return `${text.slice(0, max - 1)}...`;
}

export function shouldUseMarkdownCard(value) {
  const text = String(value || '');
  return /```[\s\S]*?```/.test(text) || /\|.+\|[\r\n]+\|[-:| ]+\|/.test(text);
}

export function buildMarkdownReplyCard(text) {
  return {
    schema: '2.0',
    config: {
      wide_screen_mode: true,
      enable_forward: true,
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: String(text || ''),
        },
      ],
    },
  };
}

function asMarkdownBlock(lines) {
  return lines.map((line) => String(line || '').trim()).filter(Boolean).join('\n');
}

function markdownElement(content) {
  return {
    tag: 'markdown',
    content,
  };
}

function noteElement(content) {
  return {
    tag: 'note',
    elements: [
      {
        tag: 'plain_text',
        content,
      },
    ],
  };
}

function buildActionButtons(buttons = []) {
  const actions = buttons.filter(Boolean).map((button) => ({
    tag: 'button',
    text: {
      tag: 'plain_text',
      content: button.label,
    },
    ...(button.type ? { type: button.type } : {}),
    value: button.value || {},
  }));
  if (actions.length === 0) {
    return null;
  }
  return {
    tag: 'action',
    actions,
  };
}

function buildCard({ title, template = 'blue', blocks = [], footer = '', buttons = [] }) {
  const elements = blocks.filter(Boolean).map((block) => markdownElement(block));
  const actionBlock = buildActionButtons(buttons);
  if (actionBlock) {
    elements.push(actionBlock);
  }
  if (footer) {
    elements.push(noteElement(footer));
  }

  return {
    schema: '2.0',
    config: {
      wide_screen_mode: true,
      enable_forward: true,
    },
    header: {
      template,
      title: {
        tag: 'plain_text',
        content: title,
      },
    },
    body: {
      elements,
    },
  };
}

function buildLegacyActionCard({ title, template = 'blue', blocks = [], footer = '', buttons = [] }) {
  const elements = blocks.filter(Boolean).map((block) => markdownElement(block));
  const actionBlock = buildActionButtons(buttons);
  if (actionBlock) {
    elements.push(actionBlock);
  }
  if (footer) {
    elements.push(noteElement(footer));
  }

  return {
    config: {
      wide_screen_mode: true,
      enable_forward: true,
    },
    header: {
      template,
      title: {
        tag: 'plain_text',
        content: title,
      },
    },
    elements,
  };
}

export function buildThinkingCard({ runnerName, requestId = '' }) {
  return buildCard({
    title: `${runnerName} is working`,
    template: 'wathet',
    blocks: [
      asMarkdownBlock([
        'Processing your message.',
        requestId ? `- request: \`${requestId}\`` : '',
      ]),
    ],
    footer: 'A final reply will be sent separately when the run finishes.',
  });
}

export function buildQueueCard({ runnerName, position, activeRequestId = '' }) {
  return buildCard({
    title: `${runnerName} queued`,
    template: 'orange',
    blocks: [
      asMarkdownBlock([
        `- position: ${position}`,
        activeRequestId ? `- active request: \`${activeRequestId}\`` : '',
      ]),
    ],
    footer: 'This request is waiting for the current run to finish.',
  });
}

export function buildProgressCard({ runnerName, sessionId = '', elapsed = '0m0s', requestId = '', waitingApproval = false }) {
  return buildCard({
    title: waitingApproval ? `${runnerName} is waiting for approval` : `${runnerName} is still working`,
    template: waitingApproval ? 'orange' : 'blue',
    blocks: [
      asMarkdownBlock([
        `- elapsed: ${elapsed}`,
        requestId ? `- request: \`${requestId}\`` : '',
        sessionId ? `- session: \`${sessionId}\`` : '',
      ]),
    ],
  });
}

export function buildFailureCard({ runnerName, reason = 'failed', code = '', signal = '', details = '' }) {
  const summary = asMarkdownBlock([
    `- reason: ${reason}`,
    `- exit: code=${code || 'none'} signal=${signal || 'none'}`,
  ]);
  const detailBlock = truncate(details, 1500)
    ? asMarkdownBlock([
        '```',
        truncate(details, 1500),
        '```',
      ])
    : '';

  return buildCard({
    title: `${runnerName} run failed`,
    template: 'red',
    blocks: [summary, detailBlock],
  });
}

export function buildApprovalCard({
  approvalId = '',
  runnerName,
  sessionId = '',
  command = '',
  description = '',
  rootId = '',
  kind = 'tool',
  message = '',
}) {
  const toolButtons = approvalId
    ? [
        {
          label: 'Approve once',
          type: 'primary',
          value: { approval_id: approvalId, decision: 'approve_once' },
        },
        {
          label: 'Approve + remember',
          value: { approval_id: approvalId, decision: 'approve_always' },
        },
        {
          label: 'Reject',
          type: 'danger',
          value: { approval_id: approvalId, decision: 'reject' },
        },
      ]
    : [];
  const checkpointButtons = approvalId
    ? [
        {
          label: 'Confirm',
          type: 'primary',
          value: { approval_id: approvalId, decision: 'confirm' },
        },
        {
          label: 'Skip',
          value: { approval_id: approvalId, decision: 'skip' },
        },
        {
          label: 'Revise',
          value: { approval_id: approvalId, decision: 'revise' },
        },
      ]
    : [];

  if (kind === 'checkpoint') {
    return buildLegacyActionCard({
      title: `${runnerName} checkpoint`,
      template: 'purple',
      blocks: [
        truncate(message, 1800),
        asMarkdownBlock([
          rootId
            ? 'Fallback: reply `confirm`, `skip`, `revise`, or `comment` in this thread.'
            : 'Fallback: reply `confirm`, `skip`, `revise`, or `comment` in this chat.',
        ]),
      ],
      buttons: checkpointButtons,
    });
  }

  return buildLegacyActionCard({
    title: `${runnerName} approval required`,
    template: 'orange',
    blocks: [
      asMarkdownBlock([
        sessionId ? `- session: \`${sessionId}\`` : '',
        command ? `- command: \`${truncate(command, 220)}\`` : '',
        description ? `- note: ${truncate(description, 500)}` : '',
      ]),
      asMarkdownBlock([
        'Choose one:',
        '- Approve once',
        '- Approve + remember',
        '- Reject',
        rootId
          ? 'Fallback: reply `1`, `2`, or `3` in this thread.'
          : 'Fallback: reply `1`, `2`, or `3` in this chat.',
      ]),
    ],
    buttons: toolButtons,
  });
}
