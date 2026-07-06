import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

export function dockDir() {
  return path.join(os.homedir(), '.pi', 'dock');
}

export async function ensureDockDir() {
  const dir = dockDir();
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export function pipePath(name) {
  if (process.platform === 'win32') {
    return String.raw`\\.\pipe\pi-dock-${name}`;
  }

  return path.join(dockDir(), `${name}.sock`);
}
