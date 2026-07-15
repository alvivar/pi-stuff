import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

const AGENT_NAME_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const WINDOWS_RESERVED_BASENAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
]);

export function validateAgentName(name) {
  const basename = typeof name === 'string' ? name.split('.', 1)[0].toLowerCase() : '';
  if (typeof name !== 'string' || name.length === 0 || name.length > 64 || !AGENT_NAME_PATTERN.test(name) || WINDOWS_RESERVED_BASENAMES.has(basename)) {
    throw new Error(`invalid agent name: ${String(name)}`);
  }
  return name;
}

export function dockDir() {
  return path.join(os.homedir(), '.pi', 'dock');
}

export async function ensureDockDir() {
  const dir = dockDir();
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export function manifestPath(name) {
  return path.join(dockDir(), `${validateAgentName(name)}.json`);
}

export function logPath(name) {
  return path.join(dockDir(), `${validateAgentName(name)}.log`);
}

export function pipePath(name) {
  name = validateAgentName(name);
  if (process.platform === 'win32') {
    return String.raw`\\.\pipe\pi-dock-${name}`;
  }

  return path.join(dockDir(), `${name}.sock`);
}
