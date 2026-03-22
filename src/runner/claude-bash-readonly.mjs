const BLOCKED_PATTERNS = [
  /(^|[;&|]\s*)(?:rm|mv|cp|install|mkdir|rmdir|touch|chmod|chown|ln|tee|dd|mkfs|mount|umount|kill|pkill|killall|reboot|shutdown|poweroff|halt)\b/i,
  /\b(?:systemctl|service)\s+(?:start|stop|restart|reload|enable|disable|mask|unmask|edit|set-environment|unset-environment)\b/i,
  /\b(?:docker|podman)(?:\s+compose)?\s+(?:build|create|down|exec|kill|pull|push|restart|rm|run|start|stop|up)\b/i,
  /\b(?:kubectl)\s+(?:annotate|apply|attach|cordon|create|delete|drain|edit|exec|expose|label|patch|replace|rollout|run|scale|set)\b/i,
  /\b(?:git)\s+(?:add|am|apply|bisect|branch\s+-[cCdDmM]|checkout|cherry-pick|clean|clone|commit|fetch|merge|pull|push|rebase|reset|revert|switch|tag|worktree)\b/i,
  /\b(?:npm|pnpm|yarn|pip|uv)\s+(?:add|install|publish|remove|sync|tool\s+install|tool\s+uninstall|uninstall)\b/i,
  /\b(?:claude|kimi)\s+login\b/i,
  /\b(?:curl|wget)\b(?:(?!\n).)*(?:--request|-X)\s*(?:POST|PUT|PATCH|DELETE)\b/i,
  /\b(?:curl|wget)\b(?:(?!\n).)*(?:--data|-d|--form|-F)\b/i,
  /(^|[^0-9])>>/,
  /(^|[^0-9])>\s*(?!\/dev\/null\b|&[0-9]\b)/,
  /\$\(/,
  /`[^`]*`/,
  /<<[-~]?['"]?[A-Za-z_][A-Za-z0-9_]*['"]?/,
  /\b(?:bash|sh|zsh)\b\s+-[cC]\b/,
];

const ALLOWED_SEGMENT_PATTERNS = [
  /^cat\b/i,
  /^cd\b/i,
  /^cut\b/i,
  /^df\b/i,
  /^dirname\b/i,
  /^docker\s+ps\b/i,
  /^docker\s+compose\s+ls\b/i,
  /^du\b/i,
  /^echo\b/i,
  /^env\b/i,
  /^file\b/i,
  /^find\b/i,
  /^free\b/i,
  /^grep\b/i,
  /^head\b/i,
  /^journalctl\b/i,
  /^ldd\b/i,
  /^ls\b/i,
  /^pgrep\b/i,
  /^(?:[~/.\w-]+\/)?pip\b\s+(?:freeze|list|show)\b/i,
  /^printenv\b/i,
  /^ps\b/i,
  /^pwd\b/i,
  /^readlink\b/i,
  /^realpath\b/i,
  /^service\s+--status-all\b/i,
  /^sed\b(?!.*\s-i\b)/i,
  /^sort\b/i,
  /^stat\b/i,
  /^systemctl\s+(?:cat|is-active|is-enabled|is-failed|list-dependencies|list-unit-files|list-units|show|status)\b/i,
  /^tail\b/i,
  /^tmux\s+list-(?:panes|sessions|windows)\b/i,
  /^tr\b/i,
  /^type\b/i,
  /^uniq\b/i,
  /^uptime\b/i,
  /^wc\b/i,
  /^which\b/i,
  /^(?:[~/.\w-]+\/)?(?:kimi|kimi-isolated)\b.*(?:--help|--version)\b/i,
  /^(?:[~/.\w-]+\/)?(?:kimi|kimi-isolated)\s+info\b/i,
  /^(?:[~/.\w-]+\/)?python(?:3)?\s+--version\b/i,
];

function splitShellSegments(command) {
  const segments = [];
  let current = '';
  let quote = '';
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    const next = command[i + 1] || '';
    if (quote) {
      current += char;
      if (char === quote && command[i - 1] !== '\\') {
        quote = '';
      }
      continue;
    }
    if (char === '"' || char === '\'') {
      quote = char;
      current += char;
      continue;
    }
    if (char === ';' || char === '|') {
      if (current.trim()) segments.push(current.trim());
      current = '';
      if ((char === '|' || char === '&') && next === char) i += 1;
      continue;
    }
    if (char === '&' && next === '&') {
      if (current.trim()) segments.push(current.trim());
      current = '';
      i += 1;
      continue;
    }
    current += char;
  }
  if (current.trim()) segments.push(current.trim());
  return segments;
}

function stripEnvAssignments(segment) {
  let value = segment.trim();
  while (/^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]+)\s*/.test(value)) {
    value = value.replace(/^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]+)\s*/, '').trim();
  }
  return value;
}

function stripTrailingAllowedRedirections(segment) {
  let value = segment.trim();
  while (/\s*\d*>\s*(?:\/dev\/null|&\d+)\s*$/.test(value)) {
    value = value.replace(/\s*\d*>\s*(?:\/dev\/null|&\d+)\s*$/, '').trim();
  }
  return value;
}

function extractQuotedSshCommand(segment) {
  const singleQuoted = segment.match(/'([^']*)'\s*(?:(?:\d?>\/dev\/null)|(?:\d?>&\d+)|\s)*$/);
  if (singleQuoted) return singleQuoted[1];
  const doubleQuoted = segment.match(/"((?:\\.|[^"])*)"\s*(?:(?:\d?>\/dev\/null)|(?:\d?>&\d+)|\s)*$/);
  if (doubleQuoted) return doubleQuoted[1].replace(/\\"/g, '"');
  return '';
}

function isAllowedVersionSegment(segment) {
  const normalized = stripTrailingAllowedRedirections(segment);
  return /^(?:[~/.\w-]+\/)?[A-Za-z0-9_.-]+\s+(?:--version|-V|version)$/.test(normalized);
}

function isAllowedNpmListSegment(segment) {
  const normalized = stripTrailingAllowedRedirections(segment);
  if (!/^npm\b/i.test(normalized)) return false;
  const parts = normalized.split(/\s+/).slice(1);
  while (parts[0] === '-g' || parts[0] === '--global') {
    parts.shift();
  }
  return parts[0] === 'list' || parts[0] === 'ls';
}

function isAllowedNpmViewSegment(segment) {
  const normalized = stripTrailingAllowedRedirections(segment);
  const parts = normalized.split(/\s+/);
  if (parts[0] !== 'npm') return false;
  if (parts[1] !== 'view' && parts[1] !== 'show') return false;
  if (parts.length < 4) return false;
  const fieldIndex = parts.findIndex((part, index) => index >= 2 && (part === 'version' || part === 'versions'));
  if (fieldIndex === -1) return false;
  return parts.slice(fieldIndex + 1).every((part) => part === '--json');
}

function isAllowedGitReadonlySegment(segment) {
  const normalized = stripTrailingAllowedRedirections(segment);
  const base = normalized.replace(/^git\s+-C\s+(?:"[^"]+"|'[^']+'|[^\s]+)\s+/, 'git ');
  if (/^git\s+remote\s+-v$/i.test(base)) return true;
  if (/^git\s+log\b/i.test(base)) return true;
  if (/^git\s+show\b/i.test(base)) return true;
  if (/^git\s+describe\b/i.test(base)) return true;
  if (/^git\s+branch\s+--show-current$/i.test(base)) return true;
  return false;
}

function isAllowedXargsReadonlySegment(segment) {
  const normalized = stripTrailingAllowedRedirections(segment);
  return /^xargs\s+-I\s+\{\}\s+dirname\s+\{\}$/i.test(normalized)
    || /^xargs\s+(?:cat|grep|head|ls)\b/i.test(normalized);
}

function isSafeAwkSegment(segment) {
  const normalized = stripTrailingAllowedRedirections(segment);
  const match = normalized.match(/^awk\s+('([^'\\]|\\.)*'|"([^"\\]|\\.)*")$/);
  if (!match) return false;
  const program = match[1].slice(1, -1);
  if (!/^\s*\{\s*(?:print|printf)\b[\s\S]*\}\s*$/.test(program)) return false;
  if (/\b(?:system|getline|close|fflush|nextfile)\b/.test(program)) return false;
  if (/(?:^|[^-])>>|[>|]/.test(program)) return false;
  return true;
}

function isAllowedReadonlySegment(segment) {
  return ALLOWED_SEGMENT_PATTERNS.some((pattern) => pattern.test(segment))
    || isAllowedVersionSegment(segment)
    || isAllowedNpmListSegment(segment)
    || isAllowedNpmViewSegment(segment)
    || isAllowedGitReadonlySegment(segment)
    || isAllowedXargsReadonlySegment(segment)
    || isSafeAwkSegment(segment);
}

function classifyReadOnlyShellCommand(command, { allowSsh = true } = {}) {
  if (BLOCKED_PATTERNS.some((pattern) => pattern.test(command))) return 'manual';
  const segments = splitShellSegments(command);
  if (segments.length === 0) return 'unknown';
  for (const segment of segments) {
    const normalized = stripEnvAssignments(segment);
    if (!normalized) return 'unknown';
    if (allowSsh && /^ssh\b/i.test(normalized)) {
      const remoteCommand = extractQuotedSshCommand(normalized);
      if (!remoteCommand) return 'unknown';
      const remoteVerdict = classifyReadOnlyShellCommand(remoteCommand, { allowSsh: false });
      if (remoteVerdict !== 'allow') return remoteVerdict;
      continue;
    }
    if (!isAllowedReadonlySegment(normalized)) return 'unknown';
  }
  return 'allow';
}

export function classifyReadOnlyBashInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { verdict: 'unknown', command: '' };
  }
  const command = String(input.command || '').trim();
  if (!command) {
    return { verdict: 'unknown', command: '' };
  }
  return {
    verdict: classifyReadOnlyShellCommand(command),
    command,
  };
}

export function isReadOnlyBashInput(input) {
  return classifyReadOnlyBashInput(input).verdict === 'allow';
}
