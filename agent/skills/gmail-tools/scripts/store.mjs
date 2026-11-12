import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyState } from './core.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function statePaths(scope, root = join(ROOT, '.state')) {
  if (typeof scope !== 'string' || !scope.trim() || scope.length > 200 || /[\x00-\x1f]/.test(scope)) {
    throw new Error('PI_SESSION_ID is missing/invalid. Supply --session <explicit-name> outside Pi; do not share sessions accidentally.');
  }
  const hash = createHash('sha256').update(scope).digest('hex');
  return { root, file: join(root, hash + '.json'), lock: join(root, hash + '.lock') };
}
export async function withState(scope, fn, { root } = {}) {
  const paths = statePaths(scope, root);
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  try { await mkdir(paths.lock, { mode: 0o700 }); }
  catch (e) {
    if (e.code === 'EEXIST') throw new Error('Session state is busy or has a stale lock: ' + paths.lock + '. Inspect owner.json/PID before removing it.');
    throw e;
  }
  try {
    await writeFile(join(paths.lock, 'owner.json'), JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }), { mode: 0o600 });
    let state;
    try { state = JSON.parse(await readFile(paths.file, 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') state = emptyState(); else throw new Error('Cannot read local Gmail state; it was not reset or overwritten.'); }
    const save = async data => {
      const temp = paths.file + '.' + randomUUID() + '.tmp';
      try {
        await writeFile(temp, JSON.stringify(data), { mode: 0o600 });
        await rename(temp, paths.file);
      } finally { await rm(temp, { force: true }); }
    };
    return await fn(state, save, paths);
  } finally { await rm(paths.lock, { recursive: true, force: true }); }
}
