import { assertConnection, clone, createBatch, createPlan, digest, emptyState,
  normalizeChanges, publicBatch, publicPlan, validatePlan, redact, revision, mailState } from './core.mjs';
import { invokeBrowser, withBrowserLock } from './bridge.mjs';

export const COMMANDS = ['connect', 'scan', 'inspect', 'prepare', 'apply', 'verify', 'batch'];
const fail = message => { throw new Error(message); };
const str = (v, name, max = 100, min = 1) => {
  if (typeof v !== 'string' || v.length < min || v.length > max) fail(`Invalid ${name}.`);
};
const integer = (v, name, min, max) => {
  if (v !== undefined && (!Number.isInteger(v) || v < min || v > max)) fail(`Invalid ${name}.`);
};
export function validateInput(command, p) {
  if (!p || Array.isArray(p) || typeof p !== 'object') fail('Input must be a JSON object.');
  const fields = {
    connect: ['account', 'tab_id'], scan: ['query', 'limit', 'page', 'offset', 'page_token', 'max_pages', 'include_snippets'],
    inspect: ['batch_id', 'n', 'allow_mark_read', 'max_chars', 'redact_sensitive'],
    prepare: ['batch_id', 'changes'], apply: ['plan_id', 'digest'], verify: ['plan_id'],
    batch: ['id', 'from', 'limit', 'forget'],
  }[command];
  if (!fields || Object.keys(p).some(k => !fields.includes(k))) fail('Unknown command or parameter.');
  for (const name of ['batch_id', 'plan_id', 'id']) if (fields.includes(name)) str(p[name], name);
  for (const name of ['include_snippets', 'allow_mark_read', 'redact_sensitive', 'forget']) {
    if (p[name] !== undefined && typeof p[name] !== 'boolean') fail(`${name} must be boolean.`);
  }
  if (command === 'connect') {
    str(p.account, 'account', 254, 3);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.account)) fail('Supply an explicit account email.');
    if (p.tab_id !== undefined) str(p.tab_id, 'tab_id');
  }
  if (command === 'scan') {
    str(p.query, 'query', 4000);
    integer(p.limit, 'limit', 1, 100); integer(p.page, 'page', 1, 100);
    integer(p.offset, 'offset', 0, 99); integer(p.max_pages, 'max_pages', 1, 10);
    if (p.page_token !== undefined) str(p.page_token, 'page_token');
  }
  if (command === 'inspect') {
    if (p.n === undefined) fail('n is required.');
    integer(p.n, 'n', 1, 100); integer(p.max_chars, 'max_chars', 1, 12000);
  }
  if (command === 'apply' && (typeof p.digest !== 'string' || !/^[a-f0-9]{64}$/.test(p.digest))) fail('Invalid plan digest.');
  if (command === 'batch') { integer(p.from, 'from', 1, 100); integer(p.limit, 'limit', 1, 100); }
}

const MAX_OUTPUT = 48000;
const emitted = value => JSON.stringify(value) + '\n';
const size = value => Buffer.byteLength(emitted(value));

// Exact CLI stdout for a success or error result, at most MAX_OUTPUT bytes.
export const outputText = result => emitted(bounded(result));

function bounded(data) {
  const value = clone(data);
  if (size(value) <= MAX_OUTPUT) return value;
  value.truncated = true;
  // Apply's journal (on success, or in an error report) is verbose detail; verify gives the actual state.
  const journal = value.journal ?? value.report?.journal;
  if (Array.isArray(journal)) {
    value.notice = 'Journal shortened to fit the 48KB output limit (oldest entries omitted). Run verify for the actual state.';
    while (journal.length && size(value) > MAX_OUTPUT) {
      // Drop oldest entries roughly in proportion to the excess, so large journals need few passes.
      journal.splice(0, Math.max(1, Math.floor(journal.length * (size(value) - MAX_OUTPUT) / size(value))));
    }
  }
  if (size(value) <= MAX_OUTPUT) return value;
  if (typeof value.text === 'string') {
    // Inspect: shorten the body, keeping status such as marked_read. A code point emits at most 6 bytes.
    value.notice = 'Text shortened to fit the 48KB output limit. Inspected bodies are not stored.';
    let chars = [...value.text];
    for (let excess = size(value) - MAX_OUTPUT; excess > 0 && chars.length; excess = size(value) - MAX_OUTPUT) {
      chars = chars.slice(0, -Math.ceil(excess / 6));
      value.text = chars.join('');
    }
  } else {
    const field = ['rows', 'entries', 'results'].find(k => Array.isArray(value[k]));
    if (field) {
      value.notice = 'Output bounded to 48KB. Use batch with a number range for stored metadata.';
      while (value[field].length && size(value) > MAX_OUTPUT) value[field].pop();
    }
  }
  if (size(value) <= MAX_OUTPUT) return value;
  const { ok = false, error, message, batch_id, plan_id, n, status, marked_read } = value;
  return { ok, error, message, truncated: true, batch_id, plan_id, n, status, marked_read,
    notice: 'Result details exceeded 48KB and were omitted. Stored batches/plans can be read in ranges with batch; inspected bodies are not stored.' };
}

export function recoverState(state) {
  if (!state || state.version !== 1 || !state.batches || !state.plans) fail('Invalid/unsupported local state. Do not overwrite it silently.');
  for (const p of Object.values(state.plans)) if (p.status === 'running') p.status = 'uncertain';
  return state;
}

export class GmailService {
  constructor({ state = emptyState(), save = async () => {}, browser } = {}) {
    this.state = recoverState(state);
    this.save = save;
    this.browser = browser ?? ((request, signal) => withBrowserLock(() => invokeBrowser(request, signal)));
  }
  connection() { assertConnection(this.state.connection); return this.state.connection; }
  getBatch(id) {
    if (!Object.hasOwn(this.state.batches, id)) fail('Unknown batch_id in this session.');
    return this.state.batches[id];
  }
  getPlan(id) {
    if (!Object.hasOwn(this.state.plans, id)) fail('Unknown plan_id in this session.');
    return this.state.plans[id];
  }
  request(op, extra = {}) { return { op, connection: this.connection(), ...extra }; }
  // The single owner of final persistence. Saving after a failure keeps e.g. an uncertain apply;
  // a save failure is appended to, never substituted for, the original error.
  async run(command, p, options = {}) {
    let output;
    try { output = await this.#execute(command, p, options); }
    catch (error) {
      await this.save(this.state).catch(saveError => { error.message += ` Local state could not be saved: ${saveError.message}`; });
      throw error;
    }
    await this.save(this.state);
    return output;
  }
  async #execute(command, p, { signal, confirmation }) {
    validateInput(command, p);
    if (signal?.aborted) fail('Cancelled before browser operation.');
    let output;
    if (command === 'connect') {
      const result = await this.browser({ op: 'connect', ...p }, signal);
      assertConnection(result.connection);
      this.state.connection = result.connection;
      output = { ok: true, ...result.connection };
    } else if (command === 'scan') {
      if (Object.keys(this.state.batches).length >= 20) fail('20 batches reached. Forget obsolete local snapshots with batch.');
      const c = this.connection();
      const result = await this.browser(this.request('scan', { ...p, snippets: !!p.include_snippets, limit: p.limit ?? 50 }), signal);
      const b = createBatch(c, result);
      this.state.batches[b.id] = b;
      output = { ok: true, ...publicBatch(b) };
      if (p.include_snippets) for (const row of output.rows) row.snippet = redact(result.rows.find(r => r.id === row.ref)?.snippet ?? '');
    } else if (command === 'inspect') {
      const b = this.getBatch(p.batch_id);
      if (b.account !== this.connection().account) fail('Batch belongs to another account.');
      const ref = b.rows.find(r => r.n === p.n);
      if (!ref) fail('Number not in batch.');
      const result = await this.browser(this.request('inspect', { ref, allow_mark_read: !!p.allow_mark_read, max_chars: p.max_chars ?? 6000 }), signal);
      if (result.marked_read) ref.unread = false;
      output = { ok: true, batch_id: b.id, n: p.n, marked_read: result.marked_read,
        text: p.redact_sensitive === false ? result.text : redact(result.text),
        attachment_names: result.attachment_names.map(v => p.redact_sensitive === false ? v : redact(v)),
        truncated: result.truncated, untrusted_email_content: true };
    } else if (command === 'prepare') {
      if (Object.keys(this.state.plans).length >= 20) fail('20 plans reached. Forget obsolete local plans with batch.');
      const b = this.getBatch(p.batch_id);
      if (b.account !== this.connection().account) fail('Batch belongs to another account.');
      const changes = normalizeChanges(b, p.changes);
      const refs = changes.map(c => b.rows.find(r => r.id === c.id));
      const fresh = await this.browser(this.request('lookup', { refs }), signal);
      const plan = createPlan(b, changes, fresh.rows);
      this.state.plans[plan.id] = plan;
      output = { ok: true, ...publicPlan(plan),
        approval: 'Obtain authorization in the conversation, then apply with --confirm set to this exact digest. This flag is a caller acknowledgment, not proof of human identity.' };
    } else if (command === 'apply') {
      const plan = this.getPlan(p.plan_id);
      validatePlan(plan, p.digest, this.connection().account);
      if (confirmation !== plan.digest) fail('No mutation performed. After user authorization, supply --confirm with the exact prepared digest.');
      if (signal?.aborted) fail('Cancelled before apply.');
      plan.status = 'running';
      // Persisted before the browser call so an interrupted process recovers as uncertain.
      // This covers process interruption, not power loss.
      await this.save(this.state);
      try {
        const result = await this.browser(this.request('apply', { entries: plan.entries }), signal);
        plan.status = 'completed'; plan.report = result; // The bridge throws for every failed apply.
        output = { ...result, plan_id: plan.id, status: plan.status };
      } catch (error) {
        plan.status = 'uncertain';
        plan.report = { error: error.code ?? 'interrupted', ...(error.report ? { report: error.report } : {}) };
        throw error;
      }
    } else if (command === 'verify') {
      const plan = this.getPlan(p.plan_id);
      if (plan.account !== this.connection().account) fail('Plan belongs to another account.');
      const result = await this.browser(this.request('verify', { refs: plan.entries.map(e => e.row) }), signal);
      const rows = new Map(result.rows.map(r => [r.id, r]));
      const results = plan.entries.map(e => {
        const row = rows.get(e.row.id), actual = row ? mailState(row) : null;
        return { n: e.change.n, matches: !!row && revision(row) === e.revision && digest(actual) === digest(e.after),
          still_before: !!row && digest(actual) === digest(e.before), actual, expected: e.after };
      });
      output = { ok: results.every(r => r.matches), plan_id: plan.id, status: plan.status, count: results.length, results };
    } else if (command === 'batch') {
      const b = Object.hasOwn(this.state.batches, p.id) ? this.state.batches[p.id] : undefined;
      const plan = Object.hasOwn(this.state.plans, p.id) ? this.state.plans[p.id] : undefined;
      if (!b && !plan) fail('Unknown local batch/plan ID.');
      if (p.forget) {
        if (plan?.status === 'running') fail('Cannot forget an executing plan.');
        if (b && Object.values(this.state.plans).some(v => v.batch_id === b.id)) fail('Forget dependent plans first.');
        delete this.state.batches[p.id]; delete this.state.plans[p.id];
        output = { ok: true, forgotten: p.id, mailbox_changed: false };
      } else {
        output = { ok: true, ...(b ? publicBatch(b) : publicPlan(plan)) };
        const field = b ? 'rows' : 'entries';
        output[field] = output[field].filter(r => r.n >= (p.from ?? 1)).slice(0, p.limit ?? 50);
      }
    }
    return output;
  }
}
