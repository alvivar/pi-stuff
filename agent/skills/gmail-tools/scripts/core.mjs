import { createHash, randomUUID } from 'node:crypto';

export const VERSION = 1;
export const MAX_BATCH = 100;
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const clone = value => JSON.parse(JSON.stringify(value));
export const newId = prefix => `${prefix}-${randomUUID()}`;
export const emptyState = () => ({ version: VERSION, connection: null, batches: {}, plans: {} });

export function assertConnection(connection) {
  if (!connection || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(connection.account) ||
      !/^[A-Za-z0-9_-]+$/.test(connection.tab_id) || !/^\/mail\/u\/\d+\/$/.test(connection.base_path)) {
    throw new Error('Connect to an unambiguous existing Gmail tab first.');
  }
}

export const subjectHash = row => row.subject_hash ?? createHash('sha256').update(row.subject).digest('hex');
export function identity(row) {
  return { id: row.id, sender: row.sender, senders: row.senders,
    subject_hash: subjectHash(row), time: row.time, summary: row.summary };
}
export function snapshotRow(row) {
  const { snippet, ...metadata } = row;
  return { ...metadata, subject_hash: subjectHash(row), subject: redact(row.subject) };
}
export const revision = row => digest(identity(row));
export const mailState = row => ({ unread: row.unread, labels: [...row.labels].sort() });

export function createBatch(connection, scan) {
  assertConnection(connection);
  if (!Array.isArray(scan.rows) || scan.rows.length > MAX_BATCH) throw new Error('Invalid scan size.');
  const seen = new Set();
  const rows = scan.rows.map((row, i) => {
    if (!/^[a-f0-9]{8,32}$/i.test(row.id) || seen.has(row.id) || !row.time ||
        !Array.isArray(row.labels) || typeof row.unread !== 'boolean') {
      throw new Error('Scan contains missing/duplicate stable thread IDs or incomplete metadata.');
    }
    seen.add(row.id);
    return { ...snapshotRow(row), n: i + 1, revision: revision(row) };
  });
  return { id: newId('batch'), account: connection.account, created_at: new Date().toISOString(),
    query: scan.query, page: scan.page, next_page: scan.next_page, rows };
}

export function normalizeChanges(batch, changes) {
  if (!Array.isArray(changes) || !changes.length || changes.length > MAX_BATCH) throw new Error('Supply 1-100 explicit changes.');
  const seen = new Set();
  return changes.map(change => {
    const allowed = ['n', 'add_labels', 'remove_labels', 'read', 'destination'];
    if (!change || Object.keys(change).some(k => !allowed.includes(k))) throw new Error('Unknown change field.');
    if (!Number.isInteger(change.n) || seen.has(change.n)) throw new Error('Duplicate/invalid batch number.');
    seen.add(change.n);
    const row = batch.rows.find(r => r.n === change.n);
    if (!row) throw new Error(`Number ${change.n} is not in this batch.`);
    const labels = key => {
      if (change[key] !== undefined && !Array.isArray(change[key])) throw new Error('Labels must be arrays.');
      const values = [...new Set(change[key] ?? [])];
      if (values.length > 20 || values.some(v => typeof v !== 'string' || !v.trim() || v.length > 200 || /[\x00-\x1f]/.test(v))) throw new Error('Invalid label name.');
      const reserved = new Set(['inbox', 'trash', 'spam', 'unread', 'sent', 'drafts', 'all mail', 'important', 'starred']);
      if (values.some(v => reserved.has(v.toLowerCase()) || v.startsWith('CATEGORY_'))) throw new Error('Use explicit state/destination operations, not system-label edits.');
      return values.sort();
    };
    const add_labels = labels('add_labels'), remove_labels = labels('remove_labels');
    if (add_labels.some(v => remove_labels.includes(v))) throw new Error('Cannot add and remove the same label.');
    if (change.read !== undefined && typeof change.read !== 'boolean') throw new Error('read must be boolean.');
    if (change.destination !== undefined && !['archive', 'inbox', 'trash', 'not_spam'].includes(change.destination)) throw new Error('Invalid destination.');
    if (!add_labels.length && !remove_labels.length && change.read === undefined && !change.destination) throw new Error('Empty change. Omit preserved conversations from the plan.');
    return { n: change.n, id: row.id, add_labels, remove_labels,
      ...(change.read !== undefined ? { read: change.read } : {}),
      ...(change.destination ? { destination: change.destination } : {}) };
  }).sort((a, b) => a.n - b.n);
}

export function desiredState(row, change) {
  const labels = new Set(row.labels);
  if (change.destination === 'archive' && (labels.has('Spam') || labels.has('Trash'))) throw new Error('Archive cannot implicitly rescue Spam or Trash.');
  if (change.destination === 'inbox' && (labels.has('Spam') || labels.has('Trash'))) throw new Error('Inbox cannot implicitly rescue Spam or Trash; use not_spam for Spam.');
  if (change.destination === 'not_spam' && labels.has('Trash')) throw new Error('Cannot rescue Spam from Trash.');
  for (const label of change.add_labels) labels.add(label);
  for (const label of change.remove_labels) labels.delete(label);
  if (change.destination === 'archive') labels.delete('Inbox');
  if (change.destination === 'inbox') labels.add('Inbox');
  if (change.destination === 'trash') { labels.delete('Inbox'); labels.delete('Spam'); labels.add('Trash'); }
  if (change.destination === 'not_spam' && labels.has('Spam')) { labels.delete('Spam'); labels.add('Inbox'); }
  return { unread: change.read === undefined ? row.unread : !change.read, labels: [...labels].sort() };
}

// changes come from normalizeChanges(batch, ...).
export function createPlan(batch, changes, freshRows) {
  const byId = new Map(freshRows.map(r => [r.id, r]));
  if (byId.size !== freshRows.length) throw new Error('Duplicate lookup identities.');
  const entries = changes.map(change => {
    const original = batch.rows.find(r => r.id === change.id), fresh = byId.get(change.id);
    if (!fresh || revision(fresh) !== original.revision) throw new Error(`Conversation #${change.n} changed or cannot be uniquely located. Scan a new batch.`);
    const before = mailState(fresh), after = desiredState(fresh, change);
    return { change, row: snapshotRow(fresh), revision: original.revision, before, after };
  });
  const plan = { id: newId('plan'), batch_id: batch.id, account: batch.account,
    created_at: new Date().toISOString(), entries };
  return { ...plan, digest: digest(plan), status: 'prepared' };
}

export function validatePlan(plan, expectedDigest, account) {
  const { digest: savedDigest, status, report, ...payload } = plan;
  if (account !== plan.account || expectedDigest !== savedDigest || digest(payload) !== savedDigest) throw new Error('Plan/account/digest mismatch. Prepare a new plan.');
  if (status !== 'prepared') throw new Error('This plan has already been attempted. Verify it; prepare a new plan for outstanding changes.');
}

// Redaction is a transport/privacy default, not an email-classification policy.
export function redact(text) {
  return String(text).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[access key omitted]')
    .replace(/\b(?:\d[ -]?){12,19}\b/g, '[long numeric reference omitted]')
    .replace(/\b\d{4,8}\b/g, '[number omitted]')
    .replace(/((?:password|passphrase|secret(?: access)? key|contrase\S*)\s*[:=]\s*)\S+/ig, '$1[omitted]')
    .replace(/([?&](?:token|code|key|secret|signature|otp|password)=)[^&\s]+/ig, '$1[omitted]');
}

export function publicBatch(batch) {
  return { batch_id: batch.id, account: batch.account, query: batch.query, page: batch.page,
    next_page: batch.next_page, unit: 'conversation', count: batch.rows.length,
    rows: batch.rows.map(r => ({ n: r.n, ref: r.id, sender: r.sender, subject: redact(r.subject),
      time: r.time, unread: r.unread, labels: r.labels })) };
}

export function publicPlan(plan) {
  return { plan_id: plan.id, batch_id: plan.batch_id, digest: plan.digest, status: plan.status,
    count: plan.entries.length, entries: plan.entries.map(e => ({ n: e.change.n,
      sender: e.row.sender, subject: redact(e.row.subject), time: e.row.time,
      change: e.change, already_satisfied: digest(e.before) === digest(e.after) })) };
}
