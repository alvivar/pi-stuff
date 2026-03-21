#!/usr/bin/env node
// cdp - lightweight Chrome DevTools Protocol CLI (Windows)
// Uses raw CDP over WebSocket, no Puppeteer dependency.
// Requires Node 22+ (built-in WebSocket).
//
// Per-tab persistent daemon: page commands go through a daemon that holds
// the CDP session open. Chrome's "Allow debugging" modal fires once per
// daemon (= once per tab). Daemons auto-exit after 20min idle.
//
// Windows version: uses named pipes (//./pipe/cdp-<targetId>) for IPC
// and per-daemon marker files (%TEMP%/cdp-daemon-<targetId>.json) for discovery.

import { readFileSync, writeFileSync, unlinkSync, existsSync, readdirSync } from 'fs';
import { resolve } from 'path';
import { spawn } from 'child_process';
import net from 'net';

const TIMEOUT = 15000;
const NAVIGATION_TIMEOUT = 30000;
const IDLE_TIMEOUT = 20 * 60 * 1000;
const DAEMON_CONNECT_RETRIES = 60;
const DAEMON_CONNECT_DELAY = 500;
const MIN_TARGET_PREFIX_LEN = 8;

const TEMP_DIR = process.env.TEMP || process.env.TMP || process.env.USERPROFILE || '.';
const SOCK_PREFIX = '//./pipe/cdp-';
const PAGES_CACHE = resolve(TEMP_DIR, 'cdp-pages.json');
const DAEMON_FILE_PREFIX = 'cdp-daemon-';
const DAEMON_FILE_SUFFIX = '.json';

function sockPath(targetId) { return `${SOCK_PREFIX}${targetId}`; }
function daemonFilePath(targetId) { return resolve(TEMP_DIR, `${DAEMON_FILE_PREFIX}${targetId}${DAEMON_FILE_SUFFIX}`); }

function getWsUrl() {
  const portFile = resolve(process.env.LOCALAPPDATA, 'Google/Chrome/User Data/DevToolsActivePort');
  let lines;
  try {
    lines = readFileSync(portFile, 'utf8').trim().split('\n');
  } catch (e) {
    if (e.code === 'ENOENT') {
      throw new Error(
        'Chrome DevToolsActivePort not found. Is Chrome running?\n' +
        'Enable remote debugging: open chrome://inspect/#remote-debugging and toggle the switch.'
      );
    }
    throw e;
  }
  return `ws://127.0.0.1:${lines[0]}${lines[1]}`;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Per-daemon marker files — each daemon writes its own file in %TEMP%:
//   %TEMP%/cdp-daemon-<targetId>.json
//   { "pipePath": "//./pipe/cdp-<targetId>", "pid": <number>, "startedAt": <epoch> }
//
// Mirrors the Unix pattern where each .sock file IS the registration.
// Here the .json marker file points to the named pipe (which lives in
// kernel space and can't be enumerated from Node without native addons).
// Liveness is checked by attempting to connect to the pipe, not by PID.
// ---------------------------------------------------------------------------

function registerDaemon(targetId, pid) {
  writeFileSync(daemonFilePath(targetId), JSON.stringify({
    pipePath: sockPath(targetId), pid, startedAt: Date.now(),
  }));
}

function unregisterDaemon(targetId) {
  try { unlinkSync(daemonFilePath(targetId)); } catch {}
}

/** Read all per-daemon marker files from %TEMP%. */
function listDaemonEntries() {
  let files;
  try { files = readdirSync(TEMP_DIR); } catch { return []; }
  return files
    .filter(f => f.startsWith(DAEMON_FILE_PREFIX) && f.endsWith(DAEMON_FILE_SUFFIX))
    .map(f => {
      try {
        const info = JSON.parse(readFileSync(resolve(TEMP_DIR, f), 'utf8'));
        const targetId = f.slice(DAEMON_FILE_PREFIX.length, -DAEMON_FILE_SUFFIX.length);
        return { targetId, socketPath: info.pipePath, pid: info.pid };
      } catch { return null; }
    })
    .filter(Boolean);
}

/** Try to connect to a named pipe. Resolves true/false. */
function checkPipeLive(pipePath, timeoutMs = 2000) {
  return new Promise(res => {
    const conn = net.connect(pipePath);
    const timer = setTimeout(() => { conn.destroy(); res(false); }, timeoutMs);
    conn.on('connect', () => { clearTimeout(timer); conn.destroy(); res(true); });
    conn.on('error', () => { clearTimeout(timer); res(false); });
  });
}

/** Remove marker files whose pipes are no longer reachable (parallel). */
/** Remove stale marker files, return live daemon entries. */
async function pruneStaleDaemons() {
  const entries = listDaemonEntries();
  if (entries.length === 0) return [];
  const results = await Promise.all(
    entries.map(async (entry) => {
      const alive = await checkPipeLive(entry.socketPath);
      if (!alive) unregisterDaemon(entry.targetId);
      return alive ? entry : null;
    })
  );
  return results.filter(Boolean);
}

function resolvePrefix(prefix, candidates, noun = 'target', missingHint = '') {
  const upper = prefix.toUpperCase();
  const matches = candidates.filter(candidate => candidate.toUpperCase().startsWith(upper));
  if (matches.length === 0) {
    const hint = missingHint ? ` ${missingHint}` : '';
    throw new Error(`No ${noun} matching prefix "${prefix}".${hint}`);
  }
  if (matches.length > 1) {
    throw new Error(`Ambiguous prefix "${prefix}" — matches ${matches.length} ${noun}s. Use more characters.`);
  }
  return matches[0];
}

function getDisplayPrefixLength(targetIds) {
  if (targetIds.length === 0) return MIN_TARGET_PREFIX_LEN;
  const maxLen = Math.max(...targetIds.map(id => id.length));
  for (let len = MIN_TARGET_PREFIX_LEN; len <= maxLen; len++) {
    const prefixes = new Set(targetIds.map(id => id.slice(0, len).toUpperCase()));
    if (prefixes.size === targetIds.length) return len;
  }
  return maxLen;
}

// ---------------------------------------------------------------------------
// CDP WebSocket client
// ---------------------------------------------------------------------------

class CDP {
  #ws; #id = 0; #pending = new Map(); #eventHandlers = new Map(); #closeHandlers = [];

  async connect(wsUrl) {
    return new Promise((res, rej) => {
      this.#ws = new WebSocket(wsUrl);
      this.#ws.onopen = () => res();
      this.#ws.onerror = (e) => rej(new Error('WebSocket error: ' + (e.message || e.type)));
      this.#ws.onclose = () => this.#closeHandlers.forEach(h => h());
      this.#ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && this.#pending.has(msg.id)) {
          const { resolve, reject } = this.#pending.get(msg.id);
          this.#pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message));
          else resolve(msg.result);
        } else if (msg.method && this.#eventHandlers.has(msg.method)) {
          for (const handler of [...this.#eventHandlers.get(msg.method)]) {
            handler(msg.params || {}, msg);
          }
        }
      };
    });
  }

  send(method, params = {}, sessionId, timeout = TIMEOUT) {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      const msg = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      this.#ws.send(JSON.stringify(msg));
      setTimeout(() => {
        if (this.#pending.has(id)) {
          this.#pending.delete(id);
          reject(new Error(`Timeout: ${method}`));
        }
      }, timeout);
    });
  }

  onEvent(method, handler) {
    if (!this.#eventHandlers.has(method)) this.#eventHandlers.set(method, new Set());
    const handlers = this.#eventHandlers.get(method);
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.#eventHandlers.delete(method);
    };
  }

  waitForEvent(method, timeout = TIMEOUT) {
    let settled = false;
    let off;
    let timer;
    const promise = new Promise((resolve, reject) => {
      off = this.onEvent(method, (params) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off();
        resolve(params);
      });
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        off();
        reject(new Error(`Timeout waiting for event: ${method}`));
      }, timeout);
    });
    return {
      promise,
      cancel() {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off?.();
      },
    };
  }

  onClose(handler) { this.#closeHandlers.push(handler); }
  close() { this.#ws.close(); }
}

// ---------------------------------------------------------------------------
// Command implementations — return strings, take (cdp, sessionId)
// ---------------------------------------------------------------------------

async function getPages(cdp) {
  const { targetInfos } = await cdp.send('Target.getTargets');
  return targetInfos.filter(t => t.type === 'page' && !t.url.startsWith('chrome://'));
}

function formatPageList(pages) {
  const prefixLen = getDisplayPrefixLength(pages.map(p => p.targetId));
  return pages.map(p => {
    const id = p.targetId.slice(0, prefixLen).padEnd(prefixLen);
    const title = p.title.substring(0, 54).padEnd(54);
    return `${id}  ${title}  ${p.url}`;
  }).join('\n');
}

function shouldShowAxNode(node, compact = false) {
  const role = node.role?.value || '';
  const name = node.name?.value ?? '';
  const value = node.value?.value;
  if (compact && role === 'InlineTextBox') return false;
  return role !== 'none' && role !== 'generic' && !(name === '' && (value === '' || value == null));
}

function formatAxNode(node, depth) {
  const role = node.role?.value || '';
  const name = node.name?.value ?? '';
  const value = node.value?.value;
  const indent = '  '.repeat(Math.min(depth, 10));
  let line = `${indent}[${role}]`;
  if (name !== '') line += ` ${name}`;
  if (!(value === '' || value == null)) line += ` = ${JSON.stringify(value)}`;
  return line;
}

function orderedAxChildren(node, nodesById, childrenByParent) {
  const children = [];
  const seen = new Set();
  for (const childId of node.childIds || []) {
    const child = nodesById.get(childId);
    if (child && !seen.has(child.nodeId)) {
      seen.add(child.nodeId);
      children.push(child);
    }
  }
  for (const child of childrenByParent.get(node.nodeId) || []) {
    if (!seen.has(child.nodeId)) {
      seen.add(child.nodeId);
      children.push(child);
    }
  }
  return children;
}

async function snapshotStr(cdp, sid, compact = false) {
  const { nodes } = await cdp.send('Accessibility.getFullAXTree', {}, sid, NAVIGATION_TIMEOUT);
  const nodesById = new Map(nodes.map(node => [node.nodeId, node]));
  const childrenByParent = new Map();
  for (const node of nodes) {
    if (!node.parentId) continue;
    if (!childrenByParent.has(node.parentId)) childrenByParent.set(node.parentId, []);
    childrenByParent.get(node.parentId).push(node);
  }

  const lines = [];
  const visited = new Set();
  function visit(node, depth) {
    if (!node || visited.has(node.nodeId)) return;
    visited.add(node.nodeId);
    if (shouldShowAxNode(node, compact)) lines.push(formatAxNode(node, depth));
    for (const child of orderedAxChildren(node, nodesById, childrenByParent)) {
      visit(child, depth + 1);
    }
  }

  const roots = nodes.filter(node => !node.parentId || !nodesById.has(node.parentId));
  for (const root of roots) visit(root, 0);
  for (const node of nodes) visit(node, 0);

  return lines.join('\n');
}

async function evalStr(cdp, sid, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true,
  }, sid);
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || result.exceptionDetails.exception?.description);
  }
  const val = result.result.value;
  return typeof val === 'object' ? JSON.stringify(val, null, 2) : String(val ?? '');
}

async function shotStr(cdp, sid, filePath) {
  let dpr = 1;
  try {
    const raw = await evalStr(cdp, sid, 'window.devicePixelRatio');
    const parsed = parseFloat(raw);
    if (parsed > 0) dpr = parsed;
  } catch {}

  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sid, NAVIGATION_TIMEOUT);
  const out = filePath || DEFAULT_SCREENSHOT_PATH;
  writeFileSync(out, Buffer.from(data, 'base64'));

  const lines = [out];
  lines.push(`Screenshot saved. Device pixel ratio (DPR): ${dpr}`);
  lines.push(`Coordinate mapping:`);
  lines.push(`  Screenshot pixels → CSS pixels (for CDP Input events): divide by ${dpr}`);
  lines.push(`  e.g. screenshot point (${Math.round(100 * dpr)}, ${Math.round(200 * dpr)}) → CSS (100, 200) → use clickxy <target> 100 200`);
  if (dpr !== 1) {
    lines.push(`  On this ${dpr}x display: CSS px = screenshot px / ${dpr} ≈ screenshot px × ${Math.round(100/dpr)/100}`);
  }
  return lines.join('\n');
}

async function htmlStr(cdp, sid, selector) {
  const expr = selector
    ? `document.querySelector(${JSON.stringify(selector)})?.outerHTML || 'Element not found'`
    : `document.documentElement.outerHTML`;
  return evalStr(cdp, sid, expr);
}

async function waitForDocumentReady(cdp, sid, timeoutMs = NAVIGATION_TIMEOUT) {
  const deadline = Date.now() + timeoutMs;
  let lastState = '';
  let lastError;
  while (Date.now() < deadline) {
    try {
      const state = await evalStr(cdp, sid, 'document.readyState');
      lastState = state;
      if (state === 'complete') return;
    } catch (e) {
      lastError = e;
    }
    await sleep(200);
  }

  if (lastState) {
    throw new Error(`Timed out waiting for navigation to finish (last readyState: ${lastState})`);
  }
  if (lastError) {
    throw new Error(`Timed out waiting for navigation to finish (${lastError.message})`);
  }
  throw new Error('Timed out waiting for navigation to finish');
}

async function navStr(cdp, sid, url) {
  await cdp.send('Page.enable', {}, sid);
  const loadEvent = cdp.waitForEvent('Page.loadEventFired', NAVIGATION_TIMEOUT);
  const result = await cdp.send('Page.navigate', { url }, sid);
  if (result.errorText) {
    loadEvent.cancel();
    throw new Error(result.errorText);
  }
  if (result.loaderId) {
    await loadEvent.promise;
  } else {
    loadEvent.cancel();
  }
  await waitForDocumentReady(cdp, sid, 5000);
  return `Navigated to ${url}`;
}

async function netStr(cdp, sid) {
  const raw = await evalStr(cdp, sid, `JSON.stringify(performance.getEntriesByType('resource').map(e => ({
    name: e.name.substring(0, 120), type: e.initiatorType,
    duration: Math.round(e.duration), size: e.transferSize
  })))`);
  return JSON.parse(raw).map(e =>
    `${String(e.duration).padStart(5)}ms  ${String(e.size || '?').padStart(8)}B  ${e.type.padEnd(8)}  ${e.name}`
  ).join('\n');
}

// Click element by CSS selector
async function clickStr(cdp, sid, selector) {
  if (!selector) throw new Error('CSS selector required');
  const expr = `
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, error: 'Element not found: ' + ${JSON.stringify(selector)} };
      el.scrollIntoView({ block: 'center' });
      el.click();
      return { ok: true, tag: el.tagName, text: el.textContent.trim().substring(0, 80) };
    })()
  `;
  const result = await evalStr(cdp, sid, expr);
  const r = JSON.parse(result);
  if (!r.ok) throw new Error(r.error);
  return `Clicked <${r.tag}> "${r.text}"`;
}

// Click at CSS pixel coordinates using Input.dispatchMouseEvent
async function clickXyStr(cdp, sid, x, y) {
  const cx = parseFloat(x);
  const cy = parseFloat(y);
  if (isNaN(cx) || isNaN(cy)) throw new Error('x and y must be numbers (CSS pixels)');
  const base = { x: cx, y: cy, button: 'left', clickCount: 1, modifiers: 0 };
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseMoved' }, sid);
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' }, sid);
  await sleep(50);
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' }, sid);
  return `Clicked at CSS (${cx}, ${cy})`;
}

// Type text using Input.insertText (works in cross-origin iframes, unlike eval)
async function typeStr(cdp, sid, text) {
  if (text == null || text === '') throw new Error('text required');
  await cdp.send('Input.insertText', { text }, sid);
  return `Typed ${text.length} characters`;
}

// Load-more: repeatedly click a button/selector until it disappears
async function loadAllStr(cdp, sid, selector, intervalMs = 1500) {
  if (!selector) throw new Error('CSS selector required');
  let clicks = 0;
  const deadline = Date.now() + 5 * 60 * 1000; // 5-minute hard cap
  while (Date.now() < deadline) {
    const exists = await evalStr(cdp, sid,
      `!!document.querySelector(${JSON.stringify(selector)})`
    );
    if (exists !== 'true') break;
    const clickExpr = `
      (function() {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.scrollIntoView({ block: 'center' });
        el.click();
        return true;
      })()
    `;
    const clicked = await evalStr(cdp, sid, clickExpr);
    if (clicked !== 'true') break;
    clicks++;
    await sleep(intervalMs);
  }
  return `Clicked "${selector}" ${clicks} time(s) until it disappeared`;
}

// Send a raw CDP command and return the result as JSON
async function evalRawStr(cdp, sid, method, paramsJson) {
  if (!method) throw new Error('CDP method required (e.g. "DOM.getDocument")');
  let params = {};
  if (paramsJson) {
    try { params = JSON.parse(paramsJson); }
    catch { throw new Error(`Invalid JSON params: ${paramsJson}`); }
  }
  const result = await cdp.send(method, params, sid);
  return JSON.stringify(result, null, 2);
}

// ---------------------------------------------------------------------------
// Per-tab daemon
// ---------------------------------------------------------------------------

async function runDaemon(targetId) {
  const sp = sockPath(targetId);

  const cdp = new CDP();
  let wsUrl;
  try {
    wsUrl = getWsUrl();
  } catch (e) {
    process.stderr.write(`Daemon: ${e.message}\n`);
    process.exit(1);
  }
  try {
    await cdp.connect(wsUrl);
  } catch (e) {
    process.stderr.write(
      `Daemon: cannot connect to Chrome.\n` +
      `Is Chrome still running with remote debugging enabled?\n` +
      `Enable it at chrome://inspect/#remote-debugging\n`
    );
    process.exit(1);
  }

  let sessionId;
  try {
    const res = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    sessionId = res.sessionId;
    await cdp.send('Runtime.enable', {}, sessionId);
  } catch (e) {
    process.stderr.write(`Daemon: attach failed: ${e.message}\n`);
    cdp.close();
    process.exit(1);
  }

  // Best-effort cleanup: if the process exits for any reason (crash,
  // unhandled exception, kill), remove the marker file. Only unregister
  // if we actually registered — avoids deleting another daemon's marker
  // when server.listen fails with EADDRINUSE.
  let registered = false;
  process.on('exit', () => { if (registered) unregisterDaemon(targetId); });

  // Shutdown helpers
  let alive = true;
  function shutdown() {
    if (!alive) return;
    alive = false;
    server.close();
    if (registered) unregisterDaemon(targetId);
    cdp.close();
    process.exit(0);
  }

  // Exit if target goes away or Chrome disconnects
  cdp.onEvent('Target.targetDestroyed', (params) => {
    if (params.targetId === targetId) shutdown();
  });
  cdp.onEvent('Target.detachedFromTarget', (params) => {
    if (params.sessionId === sessionId) shutdown();
  });
  cdp.onClose(() => shutdown());
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Idle timer
  let idleTimer = setTimeout(shutdown, IDLE_TIMEOUT);
  function resetIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(shutdown, IDLE_TIMEOUT);
  }

  // Command dispatch — single source of truth for command names and handlers.
  // COMMANDS (module-level) maps canonical names to { handler, needsTarget }.
  // Aliases (snapshot→snap, screenshot→shot, etc.) are also in the map.
  const sid = sessionId;
  const dispatch = new Map([
    ['list',       { handler: async () => formatPageList(await getPages(cdp)) }],
    ['list_raw',   { handler: async () => JSON.stringify(await getPages(cdp)) }],
    ['snap',       { handler: async (a) => snapshotStr(cdp, sid, true), needsTarget: true }],
    ['eval',       { handler: async (a) => evalStr(cdp, sid, a[0]), needsTarget: true }],
    ['shot',       { handler: async (a) => shotStr(cdp, sid, a[0]), needsTarget: true }],
    ['html',       { handler: async (a) => htmlStr(cdp, sid, a[0]), needsTarget: true }],
    ['nav',        { handler: async (a) => navStr(cdp, sid, a[0]), needsTarget: true }],
    ['net',        { handler: async (a) => netStr(cdp, sid), needsTarget: true }],
    ['click',      { handler: async (a) => clickStr(cdp, sid, a[0]), needsTarget: true }],
    ['clickxy',    { handler: async (a) => clickXyStr(cdp, sid, a[0], a[1]), needsTarget: true }],
    ['type',       { handler: async (a) => typeStr(cdp, sid, a[0]), needsTarget: true }],
    ['loadall',    { handler: async (a) => loadAllStr(cdp, sid, a[0], a[1] ? parseInt(a[1]) : 1500), needsTarget: true }],
    ['evalraw',    { handler: async (a) => evalRawStr(cdp, sid, a[0], a[1]), needsTarget: true }],
  ]);
  // Aliases
  dispatch.set('snapshot', dispatch.get('snap'));
  dispatch.set('screenshot', dispatch.get('shot'));
  dispatch.set('navigate', dispatch.get('nav'));
  dispatch.set('network', dispatch.get('net'));
  dispatch.set('ls', dispatch.get('list'));

  async function handleCommand({ cmd, args }) {
    resetIdle();
    if (cmd === 'stop') return { ok: true, result: '', stopAfter: true };
    const entry = dispatch.get(cmd);
    if (!entry) return { ok: false, error: `Unknown command: ${cmd}` };
    try {
      const result = await entry.handler(args || []);
      return { ok: true, result: result ?? '' };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // Named pipe server — NDJSON protocol
  // Wire format: each message is one JSON object followed by \n (newline-delimited JSON).
  // Request:  { "id": <number>, "cmd": "<command>", "args": ["arg1", "arg2", ...] }
  // Response: { "id": <number>, "ok": <boolean>, "result": "<string>" }
  //           or { "id": <number>, "ok": false, "error": "<message>" }
  const server = net.createServer((conn) => {
    let buf = '';
    conn.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop(); // keep incomplete last line
      for (const line of lines) {
        if (!line.trim()) continue;
        let req;
        try {
          req = JSON.parse(line);
        } catch {
          conn.write(JSON.stringify({ ok: false, error: 'Invalid JSON request', id: null }) + '\n');
          continue;
        }
        handleCommand(req).then((res) => {
          const payload = JSON.stringify({ ...res, id: req.id }) + '\n';
          if (res.stopAfter) conn.end(payload, shutdown);
          else conn.write(payload);
        });
      }
    });
  });

  // Handle listen errors (e.g. EADDRINUSE if another daemon already owns
  // this pipe). With the `registered` flag, the exit handler won't delete
  // the other daemon's marker file.
  server.on('error', (e) => {
    process.stderr.write(`Daemon: pipe listen failed: ${e.message}\n`);
    cdp.close();
    process.exit(1);
  });

  // Start listening on the named pipe, then write the marker file.
  // This order guarantees that by the time the marker is visible to other
  // processes (via pruneStaleDaemons / listDaemonEntries), the pipe is
  // already accepting connections — mirroring the Unix pattern where
  // server.listen() atomically creates the socket file.
  server.listen(sp, () => {
    registered = true;
    registerDaemon(targetId, process.pid);
  });

  // Keep the async function pending forever — the daemon runs until
  // shutdown() calls process.exit(). Without this, the resolved promise
  // would trigger the process.exit(0) in main()'s .then() handler.
  return new Promise(() => {});
}

// ---------------------------------------------------------------------------
// CLI ↔ daemon communication
// ---------------------------------------------------------------------------

function connectToSocket(sp) {
  return new Promise((resolve, reject) => {
    const conn = net.connect(sp);
    conn.on('connect', () => resolve(conn));
    conn.on('error', reject);
  });
}

async function getOrStartTabDaemon(targetId) {
  const sp = sockPath(targetId);
  // Try existing daemon
  try { return await connectToSocket(sp); } catch {}

  // Spawn daemon
  const child = spawn(process.execPath, [process.argv[1], '_daemon', targetId], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  // Detect early daemon death (e.g. Chrome closed, attach failed).
  let childDead = false;
  child.on('exit', () => { childDead = true; });

  // Wait for named pipe (includes time for user to click Allow)
  for (let i = 0; i < DAEMON_CONNECT_RETRIES; i++) {
    await sleep(DAEMON_CONNECT_DELAY);
    if (childDead) throw new Error('Daemon exited immediately — is Chrome running with remote debugging enabled?');
    try { return await connectToSocket(sp); } catch {}
  }
  throw new Error('Daemon failed to start — did you click Allow in Chrome?');
}

function sendCommand(conn, req, timeoutMs = NAVIGATION_TIMEOUT) {
  return new Promise((resolve, reject) => {
    let buf = '';
    let done = false;

    function settle(fn) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      conn.removeAllListeners();
      fn();
    }

    const timer = setTimeout(() => settle(() => {
      conn.destroy();
      reject(new Error(`Command timed out after ${timeoutMs}ms: ${req.cmd}`));
    }), timeoutMs);

    conn.on('data', (chunk) => {
      buf += chunk.toString();
      const idx = buf.indexOf('\n');
      if (idx === -1) return;
      settle(() => {
        resolve(JSON.parse(buf.slice(0, idx)));
        conn.destroy();
      });
    });

    conn.on('error', (error) => settle(() => reject(error)));
    conn.on('close', () => settle(() => reject(new Error('Connection closed before response'))));

    req.id = 1;
    conn.write(JSON.stringify(req) + '\n');
  });
}

// ---------------------------------------------------------------------------
// Stop daemons
// ---------------------------------------------------------------------------

async function stopDaemons(targetPrefix) {
  const daemons = listDaemonEntries();
  const targets = targetPrefix
    ? [daemons.find(d => d.targetId === resolvePrefix(targetPrefix, daemons.map(d => d.targetId), 'daemon'))]
    : daemons;

  for (const daemon of targets) {
    try {
      const conn = await connectToSocket(daemon.socketPath);
      await sendCommand(conn, { cmd: 'stop' });
    } catch {
      // Daemon unreachable — force-kill if PID is still alive, then remove marker
      try { process.kill(daemon.pid); } catch {}
      unregisterDaemon(daemon.targetId);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const DEFAULT_SCREENSHOT_PATH = resolve(TEMP_DIR, 'screenshot.png');

const USAGE = `cdp - lightweight Chrome DevTools Protocol CLI for Windows (no Puppeteer)

Usage: cdp <command> [args]

  list                              List open pages (shows unique target prefixes)
  snap  <target>                    Accessibility tree snapshot
  eval  <target> <expr>             Evaluate JS expression
  shot  <target> [file]             Screenshot (default: ${DEFAULT_SCREENSHOT_PATH}); prints coordinate mapping
  html  <target> [selector]         Get HTML (full page or CSS selector)
  nav   <target> <url>              Navigate to URL and wait for load completion
  net   <target>                    Network performance entries
  click   <target> <selector>       Click an element by CSS selector
  clickxy <target> <x> <y>          Click at CSS pixel coordinates (see coordinate note below)
  type    <target> <text>           Type text at current focus via Input.insertText
                                    Works in cross-origin iframes unlike eval-based approaches
  loadall <target> <selector> [ms]  Repeatedly click a "load more" button until it disappears
                                    Optional interval in ms between clicks (default 1500)
  evalraw <target> <method> [json]  Send a raw CDP command; returns JSON result
                                    e.g. evalraw <t> "DOM.getDocument" '{}'
  stop  [target]                    Stop daemon(s)

<target> is a unique targetId prefix from "cdp list". If a prefix is ambiguous,
use more characters.

COORDINATE SYSTEM
  shot captures the viewport at the device's native resolution.
  The screenshot image size = CSS pixels × DPR (device pixel ratio).
  For CDP Input events (clickxy, etc.) you need CSS pixels, not image pixels.

    CSS pixels = screenshot image pixels / DPR

  shot prints the DPR and an example conversion for the current page.
  Typical Retina (DPR=2): CSS px ≈ screenshot px × 0.5
  If your viewer rescales the image further, account for that scaling too.

EVAL SAFETY NOTE
  Avoid index-based DOM selection (querySelectorAll(...)[i]) across multiple
  eval calls when the list can change between calls (e.g. after clicking
  "Ignore" buttons on a feed — indices shift). Prefer stable selectors or
  collect all data in a single eval.

DAEMON IPC (Windows named pipes)
  Each tab runs a persistent daemon at named pipe: //./pipe/cdp-<fullTargetId>
  Each daemon writes a marker file: %TEMP%/cdp-daemon-<targetId>.json
  Protocol: newline-delimited JSON (one JSON object per line, UTF-8).
    Request:  {"id":<number>, "cmd":"<command>", "args":["arg1","arg2",...]}
    Response: {"id":<number>, "ok":true,  "result":"<string>"}
           or {"id":<number>, "ok":false, "error":"<message>"}
  Commands mirror the CLI: snap, eval, shot, html, nav, net, click, clickxy,
  type, loadall, evalraw, stop. Use evalraw to send arbitrary CDP methods.
  The pipe disappears after 20 min of inactivity or when the tab closes.
`;

// Commands that require a target prefix. Must match the needsTarget entries
// in the dispatch table inside runDaemon (and their aliases).
const NEEDS_TARGET = new Set([
  'snap','snapshot','eval','shot','screenshot','html','nav','navigate',
  'net','network','click','clickxy','type','loadall','evalraw',
]);

async function main() {
  const [cmd, ...args] = process.argv.slice(2);

  // Daemon mode (internal)
  if (cmd === '_daemon') { await runDaemon(args[0]); return; }

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(USAGE); process.exit(0);
  }

  // Stop — runs before prune so it can see marker files for daemons whose
  // pipes are dead but whose processes may still be alive (hung daemons).
  // stopDaemons handles its own cleanup (force-kill PID + remove marker).
  if (cmd === 'stop') {
    await stopDaemons(args[0]);
    return;
  }

  // Prune stale daemons once — returns live entries for reuse below.
  const liveDaemons = await pruneStaleDaemons();

  // List — use existing daemon if available, otherwise direct
  if (cmd === 'list' || cmd === 'ls') {
    let pages;
    const existingSock = liveDaemons[0]?.socketPath;
    if (existingSock) {
      try {
        const conn = await connectToSocket(existingSock);
        const resp = await sendCommand(conn, { cmd: 'list_raw' });
        if (resp.ok) pages = JSON.parse(resp.result);
      } catch {}
    }
    if (!pages) {
      // No daemon running — connect directly (will trigger one Allow)
      const cdp = new CDP();
      const wsUrl = getWsUrl(); // may throw with friendly ENOENT message
      try {
        await cdp.connect(wsUrl);
      } catch (e) {
        throw new Error(
          'Cannot connect to Chrome. Is it still running with remote debugging enabled?\n' +
          'Enable it at chrome://inspect/#remote-debugging'
        );
      }
      pages = await getPages(cdp);
      cdp.close();
    }
    writeFileSync(PAGES_CACHE, JSON.stringify(pages));
    console.log(formatPageList(pages));
    return;
  }

  // Page commands — need target prefix
  if (!NEEDS_TARGET.has(cmd)) {
    console.error(`Unknown command: ${cmd}\n`);
    console.log(USAGE);
    process.exit(1);
  }

  const targetPrefix = args[0];
  if (!targetPrefix) {
    console.error('Error: target ID required. Run "cdp list" first.');
    process.exit(1);
  }

  // Resolve prefix → full targetId from cache or running daemon
  let targetId;
  const daemonTargetIds = liveDaemons.map(d => d.targetId);
  const daemonMatches = daemonTargetIds.filter(id => id.toUpperCase().startsWith(targetPrefix.toUpperCase()));

  if (daemonMatches.length > 0) {
    targetId = resolvePrefix(targetPrefix, daemonTargetIds, 'daemon');
  } else {
    if (!existsSync(PAGES_CACHE)) {
      console.error('No page list cached. Run "cdp list" first.');
      process.exit(1);
    }
    const pages = JSON.parse(readFileSync(PAGES_CACHE, 'utf8'));
    targetId = resolvePrefix(targetPrefix, pages.map(p => p.targetId), 'target', 'Run "cdp list".');
  }

  const conn = await getOrStartTabDaemon(targetId);

  const cmdArgs = args.slice(1);

  if (cmd === 'eval') {
    const expr = cmdArgs.join(' ');
    if (!expr) { console.error('Error: expression required'); process.exit(1); }
    cmdArgs[0] = expr;
  } else if (cmd === 'type') {
    // Join all remaining args as text (allows spaces)
    const text = cmdArgs.join(' ');
    if (!text) { console.error('Error: text required'); process.exit(1); }
    cmdArgs[0] = text;
  } else if (cmd === 'evalraw') {
    // args: [method, ...jsonParts] — join json parts in case of spaces
    if (!cmdArgs[0]) { console.error('Error: CDP method required'); process.exit(1); }
    if (cmdArgs.length > 2) cmdArgs[1] = cmdArgs.slice(1).join(' ');
  }

  if ((cmd === 'nav' || cmd === 'navigate') && !cmdArgs[0]) {
    console.error('Error: URL required');
    process.exit(1);
  }

  const response = await sendCommand(conn, { cmd, args: cmdArgs });

  if (response.ok) {
    if (response.result) console.log(response.result);
  } else {
    console.error('Error:', response.error);
    process.exitCode = 1;
  }
}

main().then(
  () => process.exit(0),
  (e) => { console.error(e.message); process.exit(1); }
);
