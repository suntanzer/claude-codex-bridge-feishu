export function normalizeApprovalDecision(raw, kind = 'tool') {
  const value = String(raw || '').trim().toLowerCase();
  if (kind === 'checkpoint') {
    if (['confirm', 'proceed', 'go'].includes(value)) {
      return 'confirm';
    }
    if (['skip', 'skip it', 'pass'].includes(value)) {
      return 'skip';
    }
    if (['revise', 'change plan', 'safer plan'].includes(value)) {
      return 'revise';
    }
    if (['comment', 'note'].includes(value)) {
      return 'comment';
    }
    return '';
  }

  if (['1', 'yes', 'y', 'approve', 'approve_once', 'approve once', 'once', '同意一次'].includes(value)) {
    return 'approve_once';
  }
  if (['2', 'always', 'remember', 'approve_always', 'approve always', 'always approve', '一直同意'].includes(value)) {
    return 'approve_always';
  }
  if (['3', 'no', 'n', 'reject', 'deny', '拒绝'].includes(value)) {
    return 'reject';
  }
  return '';
}

export function approvalDecisionLabel(decision, kind = 'tool') {
  if (kind === 'checkpoint') {
    switch (decision) {
      case 'confirm':
        return 'Confirm';
      case 'skip':
        return 'Skip';
      case 'revise':
        return 'Revise';
      case 'comment':
        return 'Comment';
      case 'expired':
        return 'Expired';
      default:
        return decision;
    }
  }

  switch (decision) {
    case 'approve_once':
      return 'Approve once';
    case 'approve_always':
      return 'Approve + remember';
    case 'reject':
      return 'Reject';
    case 'expired':
      return 'Expired';
    default:
      return decision;
  }
}
