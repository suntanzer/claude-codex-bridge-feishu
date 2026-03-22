export function isRichPost(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeRichPost(input) {
  if (!isRichPost(input)) {
    return {
      message: String(input ?? ''),
      props: undefined,
      fileIds: undefined,
      priority: undefined,
    };
  }

  const message = String(input.markdown || input.message || input.text || '').trim();
  const attachments = Array.isArray(input.attachments) ? input.attachments : [];
  const props = {
    ...(input.props && typeof input.props === 'object' ? input.props : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(input.card ? { card: String(input.card) } : {}),
  };

  const normalizedProps = Object.keys(props).length > 0 ? props : undefined;
  const fileIds = Array.isArray(input.fileIds) && input.fileIds.length > 0
    ? input.fileIds.map((id) => String(id)).filter(Boolean)
    : undefined;

  return {
    message: message || (normalizedProps || fileIds ? '(see details below)' : ''),
    props: normalizedProps,
    fileIds,
    priority: input.priority || undefined,
  };
}
