import path from 'node:path';
import { promises as fs } from 'node:fs';
import { ensureDockDir, manifestPath } from './paths.mjs';

export async function writeManifest(name, manifest) {
  const dir = await ensureDockDir();
  const target = manifestPath(name);

  try {
    await fs.access(target);
    throw new Error(`manifest already exists: ${name}`);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }

  const tmp = path.join(dir, `${name}.json.${process.pid}.${Date.now()}.tmp`);
  const body = `${JSON.stringify(manifest)}\n`;

  try {
    await fs.writeFile(tmp, body, { flag: 'wx' });
    await fs.rename(tmp, target);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    throw error;
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
