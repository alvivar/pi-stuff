(req) => {
  const fail = code => { throw new Error('GMAIL_' + code); };
  const norm = s => (s || '').normalize('NFC').replace(/\s+/g, ' ').trim();
  const visible = e => !!e && e.getClientRects().length > 0;
  if (location.origin !== 'https://mail.google.com' || !/^\/mail\/u\/\d+\/$/.test(location.pathname)) fail('NOT_GMAIL');
  const accounts = [...document.querySelectorAll('[aria-label]')]
    .filter(e => visible(e) && /^Google Account:/i.test(e.getAttribute('aria-label') || ''))
    .flatMap(e => (e.getAttribute('aria-label') || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig) || []);
  const unique = [...new Set(accounts.map(s => s.toLowerCase()))];
  if (unique.length !== 1) fail('ACCOUNT_NOT_VERIFIABLE');
  if (req.account && unique[0] !== req.account.toLowerCase()) fail('ACCOUNT_CHANGED');
  if (req.base_path && location.pathname !== req.base_path) fail('ACCOUNT_PATH_CHANGED');
  const account = unique[0];
  const liveRows = () => [...document.querySelectorAll('tr.zA')].filter(visible);
  const selected = () => liveRows().filter(r => r.querySelector('[role=checkbox]')?.getAttribute('aria-checked') === 'true');
  const record = r => {
    const ids = [...new Set([...r.querySelectorAll('[data-legacy-thread-id]')].map(e => e.getAttribute('data-legacy-thread-id')))];
    if (ids.length !== 1 || !/^[a-f0-9]{8,32}$/i.test(ids[0])) fail('STABLE_THREAD_ID_UNAVAILABLE');
    const senders = [...new Set([...r.querySelectorAll('.yW span[email]')].map(e => e.getAttribute('email')))];
    const subject = norm(r.querySelector('.bog')?.textContent);
    const time = norm(r.querySelector('td.xW span[title]')?.getAttribute('title'));
    if (!senders.length || !time || subject.length > 2000) fail('INCOMPLETE_THREAD_METADATA');
    const labels = [...new Set([...r.querySelectorAll('.at')].map(e => norm(e.textContent)).filter(Boolean))];
    if (location.hash === '#inbox') labels.push('Inbox');
    if (location.hash === '#spam') labels.push('Spam');
    if (location.hash === '#trash') labels.push('Trash');
    return { id: ids[0], sender: senders[0], senders, subject, time,
      summary: norm(r.querySelector('.yW')?.textContent), labels: [...new Set(labels)].sort(),
      unread: r.classList.contains('zE'),
      ...(req.snippets ? { snippet: norm(r.querySelector('.y2')?.textContent).slice(0, 400) } : {}) };
  };
  const identity = r => JSON.stringify([r.id, r.sender, r.senders, r.subject, r.time, r.summary]);
  const find = (ref, allowMissing = false) => {
    const rs = liveRows().filter(r => record(r).id === ref.id);
    if (allowMissing && rs.length === 0) return null;
    if (rs.length !== 1) fail('IDENTITY_COUNT');
    if (identity(record(rs[0])) !== identity(ref)) fail('REVISION_CHANGED');
    return rs[0];
  };
  const checkExpected = (r, ref) => {
    const got = record(r), expected = ref.expected;
    if (expected && (got.unread !== expected.unread || JSON.stringify(got.labels) !== JSON.stringify([...expected.labels].sort()))) fail('STATE_CHANGED');
  };
  if (req.op === 'account') return { account, base_path: location.pathname, hash: location.hash };
  if (req.op === 'assert_clear') {
    if (selected().length) fail('EXISTING_SELECTION');
    return { clear: true };
  }
  if (req.op === 'rows') {
    if (selected().length) fail('EXISTING_SELECTION');
    const rows = liveRows().map(record);
    if (new Set(rows.map(r => r.id)).size !== rows.length) fail('DUPLICATE_THREAD_IDS');
    const text = document.body.innerText;
    return { account, hash: location.hash, rows,
      empty: rows.length === 0 && /No conversations|No results|Hooray, no spam|Nothing in Trash|No new mail/i.test(text),
      busy: [...document.querySelectorAll('[role=progressbar]')].some(visible) };
  }
  if (req.op === 'select') {
    if (selected().length) fail('EXISTING_SELECTION');
    if (!req.refs?.length || new Set(req.refs.map(r => r.id)).size !== req.refs.length) fail('BAD_SELECTION_REQUEST');
    const targets = req.refs.map(ref => { const r = find(ref); checkExpected(r, ref); return r; });
    for (const r of targets) {
      const cb = r.querySelector('[role=checkbox]'); if (!cb) fail('CHECKBOX_MISSING'); cb.click();
    }
    const got = selected();
    if (got.length !== targets.length || got.some(r => !targets.includes(r))) fail('SELECTION_MISMATCH');
    return { count: got.length };
  }
  if (req.op === 'check_selection' || req.op === 'deselect') {
    const targets = req.refs.map(ref => find(ref, req.op === 'deselect')).filter(Boolean);
    if (req.op === 'check_selection') req.refs.forEach((ref, i) => checkExpected(targets[i], ref));
    const got = selected();
    if (got.some(r => !targets.includes(r)) || (req.op === 'check_selection' && got.length !== targets.length)) fail('SELECTION_MISMATCH');
    if (req.op === 'deselect') for (const r of got) r.querySelector('[role=checkbox]').click();
    return { count: req.op === 'deselect' ? selected().length : got.length };
  }
  if (req.op === 'open') {
    if (selected().length) fail('EXISTING_SELECTION');
    const r = find(req.ref); checkExpected(r, req.ref);
    if (record(r).unread && !req.allow_mark_read) fail('OPEN_WOULD_MARK_READ');
    const cell = r.querySelector('.bog'); if (!cell) fail('SUBJECT_MISSING');
    cell.click(); return { opened: req.ref.id };
  }
  if (req.op === 'body') {
    if (location.hash !== req.expected_hash || norm(document.querySelector('h2.hP')?.textContent) !== req.ref.subject) fail('OPENED_VIEW_CHANGED');
    const bodies = [...document.querySelectorAll('.a3s.aiL')].filter(visible);
    if (!bodies.length) fail('BODY_UNAVAILABLE');
    const text = bodies.map(e => e.innerText).join('\n--- message ---\n');
    return { text: text.slice(0, req.max_chars), truncated: text.length > req.max_chars,
      attachment_names: [...document.querySelectorAll('.aV3')].filter(visible).map(e => norm(e.textContent)).slice(0, 30),
      untrusted_email_content: true };
  }
  fail('UNKNOWN_DOM_OPERATION');
}
