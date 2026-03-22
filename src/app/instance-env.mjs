import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..', '..');

function normalizeInstanceName(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (!value) return '';
  return value.replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

function parseEnvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
  if (!match) return null;
  let value = match[2];
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return [match[1], value];
}

async function loadEnvFile(path) {
  if (!existsSync(path)) return;
  const text = await readFile(path, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (!parsed) continue;
    const [key, value] = parsed;
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

export async function loadInstanceEnv() {
  const instanceName = normalizeInstanceName(process.env.CCMM_INSTANCE || process.env.BRIDGE_INSTANCE);
  if (!instanceName) return;
  await loadEnvFile(join(projectRoot, 'instances', 'common.env'));
  await loadEnvFile(join(projectRoot, 'instances', `${instanceName}.env`));
}
