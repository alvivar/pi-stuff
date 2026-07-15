import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { ensureDockDir, manifestPath } from './paths.mjs';

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
  const dir = await ensureDockDir();
  const tmp = path.join(dir, `${name}.json.${process.pid}.${randomUUID()}.tmp`);
  const body = `${JSON.stringify(manifest)}\n`;
  const handle = await fs.open(tmp, 'wx');

  try {
    await handle.writeFile(body);
    await handle.close();
    return tmp;
  } catch (error) {
    await handle.close().catch(() => {});
    await removeOwnedTempManifest(tmp);
    throw error;
  }
}

export async function writeManifest(name, manifest) {
  const target = manifestPath(name);
  const tmp = await writeTempManifest(name, manifest);

  try {
    await fs.link(tmp, target);
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new ManifestExistsError(name);
    }
    throw error;
  } finally {
    await removeOwnedTempManifest(tmp);
  }
}

export async function rewriteManifest(name, manifest) {
  const target = manifestPath(name);
  await fs.access(target);
  const tmp = await writeTempManifest(name, manifest);

  try {
    await fs.rename(tmp, target);
  } finally {
    await removeOwnedTempManifest(tmp);
  }
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
