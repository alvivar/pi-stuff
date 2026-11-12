import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PREFIX = 'PI_GMAIL_RESULT:';
const LANE_LOCK = join(homedir(), '.config', 'browser-harness', 'tmp', 'pi-gmail-tools.lock');

// Backend error codes that wrap an unexpected exception, such as a daemon IPC timeout after a
// CDP command was submitted. Other backend codes are completed determinations.
const UNCERTAIN_CODES = new Set(['browser_error', 'apply_interrupted', 'dom_operation_failed']);

// BU_AUTOSPAWN is browser-use's opt-in for starting a Browser Use Cloud browser when no local
// daemon or Chrome answers. Case variants are dropped (Windows env names are case-insensitive)
// and the canonical name is set empty, because browser-use's .env loading only fills unset names.
// Not detected: a default daemon already running for a non-local browser. Callers must ensure
// the default daemon is local; vendor-cloud daemons are forbidden by the browser-use policy.
export const safeEnv = () => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'BU_AUTOSPAWN')),
  BU_AUTOSPAWN: '', ANONYMIZED_TELEMETRY: 'false', BH_TELEMETRY: 'false', BROWSER_HARNESS_TELEMETRY: 'false',
  BROWSER_USE_CLOUD_SYNC: 'false', BH_RECORD: '0', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' });

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
      await killedTree;
      // The daemon is outside this process tree: a CDP command already submitted may still run.
      if (stopped) reject(Object.assign(new Error('Browser operation interrupted. Mutation result may be uncertain; verify before retrying.'), { code: 'interrupted', uncertain: true }));
      else resolve({ out, err, code });
    });
    child.stdin.end(input ?? '');
  });
}

// Shared across Pi processes. A lock left after a crash is deliberately not stolen.
// It contains only a PID, not email. Inspect that PID before removing a stale lock.
// A browser failure with an unknown outcome keeps the lock: neither a killed CLI nor an IPC
// timeout stops work already submitted to the daemon, so the lane is clear only after explicit recovery.
export async function withBrowserLock(fn) {
  if (process.env.BU_NAME && process.env.BU_NAME !== 'default') throw new Error('gmail-tools uses only the default local browser-use daemon. Unset BU_NAME for this skill.');
  if (process.env.BU_CDP_URL || process.env.BU_CDP_WS) {
    throw new Error('gmail-tools supports only local Chrome and does not use BU_CDP_URL/BU_CDP_WS endpoints. Unset them for this skill.');
  }
  await mkdir(dirname(LANE_LOCK), { recursive: true });
  try { await mkdir(LANE_LOCK); }
  catch (e) { if (e.code === 'EEXIST') throw new Error(`Gmail browser lane is busy, was interrupted, or has a stale lock: ${LANE_LOCK}. Inspect owner.json; do not remove it while its owner is alive or before recovery.`); throw e; }
  let keepLock = false;
  try {
    await writeFile(join(LANE_LOCK, 'owner.json'), JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }), { mode: 0o600 });
    const status = await runProcess(['telemetry', 'status'], '', undefined, 15000);
    let telemetry;
    try { telemetry = JSON.parse(status.out); } catch { throw new Error('Cannot verify browser-use telemetry status.'); }
    if (status.code !== 0 || telemetry.enabled !== false || telemetry.install_id !== null) throw new Error('Browser-use telemetry is not disabled with a null install_id. Stopped.');
    try { return await fn(); }
    catch (error) {
      if (!error.uncertain) throw error;
      keepLock = true;
      error.message += ` Browser lane lock kept at ${LANE_LOCK}: confirm the Gmail tab is idle, then remove it and verify before any new change.`;
      throw error;
    }
  } finally { if (!keepLock) await rm(LANE_LOCK, { recursive: true, force: true }); }
}

export async function invokeBrowser(request, signal) {
  const script = [
    'import sys, json',
    `sys.path.insert(0, ${JSON.stringify(ROOT)})`,
    'from gmail_backend import GmailError, dispatch',
    `request = json.loads(${JSON.stringify(JSON.stringify(request))})`,
    'try:',
    '    result = dispatch(request, globals())',
    'except Exception as exc:',
    '    result = {"ok": False, "error": exc.code if isinstance(exc, GmailError) else "browser_error", "message": str(exc)[:500], "report": getattr(exc, "report", None)}',
    `print(${JSON.stringify(PREFIX)} + json.dumps(result, ensure_ascii=True))`,
  ].join('\n') + '\n';
  // Entire input is ASCII; no shell interpolation and no Windows code-page surprises.
  const ascii = script.replace(/[\u007f-\uffff]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return parseBrowserResult(await runProcess([], ascii, signal, request.op === 'apply' ? 600000 : 180000));
}

// A worker that dies while printing can leave no result or a truncated one; both are uncertain.
const noResponse = () => Object.assign(new Error('No structured response from browser-use. Reconnect; do not blindly repeat a mutation.'),
  { code: 'no_response', uncertain: true });

export function parseBrowserResult(result) {
  const line = result.out.split(/\r?\n/).findLast(s => s.startsWith(PREFIX));
  if (!line) {
    if (/Allow remote debugging|handshake/i.test(result.err + result.out)) throw new Error('Chrome requires remote-debugging consent. Ask the user to click Allow; do not approve it automatically.');
    throw noResponse();
  }
  let parsed;
  try { parsed = JSON.parse(line.slice(PREFIX.length)); } catch { throw noResponse(); }
  if (result.code !== 0 || parsed.ok === false) {
    throw Object.assign(new Error(parsed.message || 'Gmail operation failed.'),
      { code: parsed.error, report: parsed.report, uncertain: UNCERTAIN_CODES.has(parsed.error) });
  }
  return parsed;
}
