import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { dockDir, ensureDockDir, manifestPath } from './paths.mjs';

export class ManifestExistsError extends Error {
  constructor(name) {
    super(`manifest already exists: ${name}`);
    this.name = 'ManifestExistsError';
  }
}

async function removeOwnedTempManifest(tmp) {
  await fs.rm(tmp, { force: true }).catch(() => {});
}

async function writeTempManifest(name, manifest) {
  const tmp = path.join(dockDir(), `${name}.json.${process.pid}.${randomUUID()}.tmp`);
  const body = `${JSON.stringify(manifest)}\n`;

  try {
    await fs.writeFile(tmp, body, { flag: 'wx' });
    return tmp;
  } catch (error) {
    await removeOwnedTempManifest(tmp);
    throw error;
  }
}

// Readers see either the old file or the complete new one.
async function renameIntoPlace(name, manifest) {
  const tmp = await writeTempManifest(name, manifest);

  try {
    await fs.rename(tmp, manifestPath(name));
  } finally {
    await removeOwnedTempManifest(tmp);
  }
}

async function isPresent(file) {
  try {
    await fs.lstat(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

// The check and the rename are not one atomic step: two creators could both pass the check.
// Only the runner that owns the agent's pipe creates its manifest, so this relies on exclusive
// pipe ownership, which the Unix stale-socket race (DESIGN item 5) can break.
// No hard link (link + EEXIST would be atomic): Android forbids them in app storage.
export async function writeManifest(name, manifest) {
  if (await isPresent(manifestPath(name))) {
    throw new ManifestExistsError(name);
  }
  await renameIntoPlace(name, manifest);
}

export async function rewriteManifest(name, manifest) {
  await fs.access(manifestPath(name));
  await renameIntoPlace(name, manifest);
}

export async function readManifest(name) {
  const body = await fs.readFile(manifestPath(name), 'utf8');
  return JSON.parse(body);
}

export async function listManifests() {
  const dir = await ensureDockDir();
  const entries = await fs.readdir(dir);
  const names = entries
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => entry.slice(0, -'.json'.length))
    .sort();

  return Promise.all(names.map((name) => readManifest(name)));
}
