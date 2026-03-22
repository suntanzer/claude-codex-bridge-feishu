export function nowMs() {
  return Date.now();
}

export function nowIso() {
  return new Date().toISOString();
}

export function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours > 0) {
    return `${hours}h${remMins}m${secs}s`;
  }
  return `${mins}m${secs}s`;
}

export function parseIsoMs(value) {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function formatAgeFromIso(value) {
  const ts = parseIsoMs(value);
  if (!ts) return 'n/a';
  return formatElapsed(nowMs() - ts);
}
