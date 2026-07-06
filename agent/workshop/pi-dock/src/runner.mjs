import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { writeManifest } from './manifest.mjs';
import { dockDir, ensureDockDir, pipePath } from './paths.mjs';
import { serve } from './pipe.mjs';

const { values } = parseArgs({
  options: {
    name: { type: 'string' },
  },
});

const name = values.name;

if (!name) {
  process.exit(1);
}

const logPath = path.join(dockDir(), `${name}.log`);
let n = 0;
let server;
let heartbeat;

function appendLog(event) {
  appendFileSync(logPath, `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`, 'utf8');
}

function stopSoon() {
  setImmediate(() => {
    appendLog({ event: 'stopped' });
    clearInterval(heartbeat);
    server.close(() => process.exit(0));
  });
}

await ensureDockDir();

const startedAt = new Date().toISOString();
const pipe = pipePath(name);

await writeManifest(name, {
  name,
  sessionFile: null,
  cwd: process.cwd(),
  modelId: null,
  budget: null,
  pipe,
  startedAt,
});

appendLog({ event: 'spawned' });

server = serve(pipe, (msg) => {
  if (msg.cmd === 'status') {
    return { ok: true, state: 'idle', turns: n };
  }

  if (msg.cmd === 'stop') {
    stopSoon();
    return { ok: true };
  }

  return { ok: false, error: 'unknown' };
});

server.on('error', (error) => {
  appendLog({ event: 'failed', reason: error.message });
  process.exit(1);
});

heartbeat = setInterval(() => {
  appendLog({ event: 'heartbeat', n });
  n += 1;
}, 2000);
