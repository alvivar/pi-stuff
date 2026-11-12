import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PREFIX = 'PI_GMAIL_RESULT:';
export const safeEnv = () => ({ ...process.env, ANONYMIZED_TELEMETRY: 'false', BH_TELEMETRY: 'false',
  BROWSER_HARNESS_TELEMETRY: 'false', BROWSER_USE_CLOUD_SYNC: 'false', BH_RECORD: '0',
  PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' });

export function runProcess(args, input, signal, timeout = 120000) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Cancelled before browser operation.'));
    const child = spawn('browser-use', args, { env: safeEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
    let out = '', err = '', stopped = false, killedTree = Promise.resolve();
    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (!child.pid) return;
      if (process.platform === 'win32') {
        killedTree = new Promise(done => {
          const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          killer.once('error', () => { child.kill(); done(); });
          killer.once('close', () => done());
        });
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    };
    const timer = setTimeout(stop, timeout);
    signal?.addEventListener('abort', stop, { once: true });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { out += chunk; if (Buffer.byteLength(out) > 2 * 1024 * 1024) stop(); });
    child.stderr.on('data', chunk => { err = (err + chunk).slice(-8192); });
    child.stdin.on('error', () => {});
    child.once('error', error => { clearTimeout(timer); signal?.removeEventListener('abort', stop); reject(new Error(`Cannot start browser-use: ${error.code ?? 'spawn error'}`)); });
    child.once('close', async code => {
      clearTimeout(timer); signal?.removeEventListener('abort', stop);
      await killedTree; // Do not release the browser lock while a worker can still mutate.
      if (stopped) reject(new Error('Browser operation interrupted. Mutation result may be uncertain; verify before retrying.'));
      else resolve({ out, err, code });
    });
    child.stdin.end(input ?? '');
  });
}

// Shared across Pi processes. A lock left after a crash is deliberately not stolen.
// It contains only a PID, not email. Inspect that PID before removing a stale lock.
export async function withBrowserLock(fn) {
  if (process.env.BU_NAME && process.env.BU_NAME !== 'default') throw new Error('gmail-tools uses the default local browser-use daemon. Unset BU_NAME.');
  if (process.env.BU_CDP_URL || process.env.BU_CDP_WS || process.env.BH_OPEN_LIVE_URL || process.env.BH_REQUIRE_EXISTING_DAEMON) {
    throw new Error('This local-only adapter refuses remote/live-view endpoints. Use a separate explicitly configured adapter.');
  }
  const lock = join(homedir(), '.config', 'browser-harness', 'tmp', 'pi-gmail-tools.lock');
  await mkdir(dirname(lock), { recursive: true });
  try { await mkdir(lock); }
  catch (e) { if (e.code === 'EEXIST') throw new Error(`Gmail browser lane is busy or has a stale lock: ${lock}. Do not remove it while its owner is alive.`); throw e; }
  try {
    await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }), { mode: 0o600 });
    const status = await runProcess(['telemetry', 'status'], '', undefined, 15000);
    let telemetry;
    try { telemetry = JSON.parse(status.out); } catch { throw new Error('Cannot verify browser-use telemetry status.'); }
    if (status.code !== 0 || telemetry.enabled !== false || telemetry.install_id !== null) throw new Error('Browser-use telemetry is not disabled with a null install_id. Stopped.');
    return await fn();
  } finally { await rm(lock, { recursive: true, force: true }); }
}

export async function invokeBrowser(request, signal) {
  const script = [
    'import sys, json',
    `sys.path.insert(0, ${JSON.stringify(ROOT)})`,
    'from gmail_backend import dispatch',
    `request = json.loads(${JSON.stringify(JSON.stringify(request))})`,
    'try:',
    '    result = dispatch(request, globals())',
    'except Exception as exc:',
    '    result = {"ok": False, "error": getattr(exc, "code", "browser_error"), "message": str(exc)[:500], "report": getattr(exc, "report", None)}',
    `print(${JSON.stringify(PREFIX)} + json.dumps(result, ensure_ascii=True))`,
  ].join('\n') + '\n';
  // Entire input is ASCII; no shell interpolation and no Windows code-page surprises.
  const ascii = script.replace(/[\u007f-\uffff]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  const result = await runProcess([], ascii, signal, request.op === 'apply' ? 600000 : 180000);
  const line = result.out.split(/\r?\n/).findLast(s => s.startsWith(PREFIX));
  if (!line) {
    if (/Allow remote debugging|handshake/i.test(result.err + result.out)) throw new Error('Chrome requires remote-debugging consent. Ask the user to click Allow; do not approve it automatically.');
    throw new Error('No structured response from browser-use. Reconnect; do not blindly repeat a mutation.');
  }
  const parsed = JSON.parse(line.slice(PREFIX.length));
  if (result.code !== 0 || parsed.ok === false) {
    const error = new Error(parsed.message || 'Gmail operation failed.');
    error.code = parsed.error; error.report = parsed.report;
    throw error;
  }
  return parsed;
}
