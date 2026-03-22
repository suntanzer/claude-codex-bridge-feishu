export function isDirectMessage(payload) {
  return payload?.data?.channel_type === 'D';
}

export function makeThreadKey(channelId, rootId) {
  return `mattermost:${channelId}:${rootId}`;
}

export function makeChannelApprovalKey(channelId) {
  return `mattermost:${channelId}:`;
}

export function parseThreadKey(threadKey) {
  const match = /^mattermost:([^:]+):([^:]+)$/.exec(String(threadKey || ''));
  if (!match) return null;
  return { channelId: match[1], rootId: match[2] };
}

export function parseCommand(text, prefix = '!bridge') {
  const trimmed = String(text || '').trim();
  if (!trimmed.toLowerCase().startsWith(prefix.toLowerCase())) {
    return null;
  }
  const rest = trimmed.slice(prefix.length).trim();
  const [command = 'help', ...args] = rest ? rest.split(/\s+/) : [];
  return { command: command.toLowerCase(), args, rawArgs: rest };
}
