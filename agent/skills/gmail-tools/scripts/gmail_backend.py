"""Local Gmail UI adapter. No Gmail API, credentials, classification, or personal rules."""
import hashlib
import json
import re
import time
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import quote, unquote_plus, urlparse

DOM = Path(__file__).with_name('dom.js').read_text(encoding='utf-8')


class GmailError(RuntimeError):
    def __init__(self, code, message=None):
        self.code = code
        super().__init__(message or code)


def identity(row):
    subject_hash = row.get('subject_hash') or hashlib.sha256(row['subject'].encode('utf-8')).hexdigest()
    return [row['id'], row['sender'], row['senders'], subject_hash, row['time'], row['summary']]


def state(row):
    return {'unread': row['unread'], 'labels': sorted(row['labels'])}


def lookup_query(refs):
    dates, senders = [], set()
    for ref in refs:
        try:
            dates.append(datetime.strptime(re.sub(r'\s+', ' ', ref['time']), '%a, %b %d, %Y, %I:%M %p'))
        except ValueError:
            raise GmailError('unsupported_date_format', 'Expected English Gmail full date titles; no mutation attempted.')
        sender = ref['sender']
        if not re.fullmatch(r'[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+', sender):
            raise GmailError('unsupported_sender')
        senders.add(sender)
    if not dates:
        raise GmailError('empty_lookup')
    start = (min(dates) - timedelta(days=2)).strftime('%Y/%m/%d')
    end = (max(dates) + timedelta(days=2)).strftime('%Y/%m/%d')
    return 'in:anywhere after:' + start + ' before:' + end + ' {' + ' '.join('from:' + s for s in sorted(senders)) + '}'


class GmailUI:
    def __init__(self, helpers, connection):
        self.h = helpers
        self.c = connection
        self.query = None
        self.snippets = False
        self.page = 1

    def dom(self, op, **args):
        request = dict(op=op, account=self.c['account'], base_path=self.c['base_path'], **args)
        try:
            return self.h['js']('(' + DOM + ')(' + json.dumps(request, ensure_ascii=True) + ')')
        except Exception as exc:
            # Never echo evaluated JavaScript, message subjects, or body data in errors.
            match = re.search(r'GMAIL_([A-Z_]+)', str(exc))
            raise GmailError(match.group(1).lower() if match else 'dom_operation_failed') from None

    def guard(self):
        return self.dom('account')

    def rows(self):
        result = self.dom('rows', snippets=self.snippets)
        if self.query is not None:
            value = result['hash'].removeprefix('#search/').split('/')[0]
            if not result['hash'].startswith('#search/') or unquote_plus(value) != self.query:
                raise GmailError('view_changed', 'Gmail view changed concurrently; stopped without retrying a mutation.')
        return result

    def wait_rows(self, old_ids=None):
        deadline, previous, stable = time.monotonic() + 15, None, 0
        while time.monotonic() < deadline:
            try:
                result = self.rows()
            except GmailError as exc:
                if exc.code not in ('view_changed',):
                    raise
                time.sleep(.15)
                continue
            ids = [r['id'] for r in result['rows']]
            signature = (result['hash'], tuple(ids))
            stable = stable + 1 if signature == previous else 0
            previous = signature
            if not result['busy'] and stable >= 2 and (ids or result['empty']) and (old_ids is None or ids != old_ids):
                return result
            time.sleep(.2)
        raise GmailError('list_not_ready', 'Gmail list did not stabilize. Unsupported locale/view or concurrent navigation.')

    def search(self, query):
        self.guard()
        self.dom('assert_clear')
        self.query = query
        self.page = 1
        url = 'https://mail.google.com' + self.c['base_path'] + '#search/' + quote(query, safe='')
        self.h['goto_url'](url)
        time.sleep(.6)  # Gmail's hash can change before the result table is replaced.
        return self.wait_rows()

    def nodes(self, role, names):
        names = set(names)
        return [n for n in self.h['cdp']('Accessibility.getFullAXTree')['nodes']
                if n.get('role', {}).get('value') == role and n.get('name', {}).get('value') in names
                and not n.get('ignored', False)]

    def click_node(self, node, refs=None):
        self.guard()
        if refs is not None:
            self.dom('check_selection', refs=refs)
        box = self.h['cdp']('DOM.getBoxModel', backendNodeId=node['backendDOMNodeId'])['model']['content']
        x, y = sum(box[0::2]) / 4, sum(box[1::2]) / 4
        if x < 0 or y < 0:
            raise GmailError('control_outside_viewport')
        self.h['click_at_xy'](x, y)

    def click(self, role, names, refs=None):
        nodes = self.nodes(role, names)
        if len(nodes) != 1:
            raise GmailError('control_not_unique', 'Required Gmail control unavailable or ambiguous: ' + '/'.join(names))
        self.click_node(nodes[0], refs)

    def older(self):
        old = [r['id'] for r in self.rows()['rows']]
        nodes = self.nodes('button', ['Older'])
        if len(nodes) != 1:
            raise GmailError('pagination_unavailable')
        if any(p.get('name') == 'disabled' and p.get('value', {}).get('value') is True for p in nodes[0].get('properties', [])):
            return False
        self.click_node(nodes[0])
        self.wait_rows(old)
        self.page += 1
        return True

    def collect(self, refs, max_pages=20):
        wanted, found = {r['id']: r for r in refs}, {}
        query = lookup_query(refs)
        current_hash = self.guard().get('hash', '')
        if current_hash.startswith('#search/') and unquote_plus(current_hash.removeprefix('#search/').split('/')[0]) == query:
            query += ' in:anywhere'  # force a fresh search route, preserving semantics
        self.search(query)
        for page in range(max_pages):
            for row in self.rows()['rows']:
                if row['id'] in wanted:
                    if row['id'] in found:
                        raise GmailError('duplicate_identity')
                    if identity(row) != identity(wanted[row['id']]):
                        raise GmailError('revision_changed', 'A target conversation received a reply or changed identity. Scan a new batch.')
                    found[row['id']] = row
            if len(found) == len(wanted):
                return list(found.values())
            if not self.older():
                break
        raise GmailError('targets_missing', 'Could not uniquely locate every target within the pagination limit; no mutation retried.')

    def mutate(self, kind, refs, label=None):
        self.dom('select', refs=refs)
        time.sleep(.35)
        if kind in ('add_label', 'remove_label'):
            self.click('button', ['Labels'], refs)
            time.sleep(.25)
            nodes = self.nodes('menuitemcheckbox', [label])
            if len(nodes) != 1:
                raise GmailError('label_not_found', 'Only existing, uniquely named Gmail labels are supported.')
            checked = next((p['value']['value'] for p in nodes[0].get('properties', []) if p['name'] == 'checked'), None)
            expected = 'false' if kind == 'add_label' else 'true'
            if checked != expected:
                raise GmailError('label_state_changed')
            self.click_node(nodes[0], refs)
            time.sleep(.3)
            apply = self.nodes('button', ['Apply']) + self.nodes('menuitem', ['Apply'])
            if len(apply) > 1:
                raise GmailError('ambiguous_apply')
            if apply:
                self.click_node(apply[0], refs)
        elif kind in ('read', 'unread', 'archive', 'trash'):
            button = {'read': 'Mark as read', 'unread': 'Mark as unread', 'archive': 'Archive', 'trash': 'Delete'}[kind]
            self.click('button', [button], refs)
        elif kind == 'inbox':
            direct = self.nodes('button', ['Move to inbox', 'Move to Inbox'])
            if len(direct) == 1:
                self.click_node(direct[0], refs)
            else:
                self.click('button', ['Move to'], refs)
                time.sleep(.3)
                self.click('menuitem', ['Inbox'], refs)
        elif kind == 'not_spam':
            direct = self.nodes('button', ['Not spam', 'Report not spam'])
            if len(direct) == 1:
                self.click_node(direct[0], refs)
            else:
                self.click('button', ['More email options'], refs)
                time.sleep(.3)
                self.click('menuitem', ['Not spam', 'Report not spam'], refs)
        else:
            raise GmailError('unsupported_operation')

    def finish_mutation(self, refs, expected):
        # Selection may persist or clear after a successful operation. Only clear
        # our exact identities; do not require their pre-mutation state here.
        self.dom('deselect', refs=refs)
        deadline = time.monotonic() + 10
        refreshed = False
        while time.monotonic() < deadline:
            current = {r['id']: r for r in self.rows()['rows']}
            if all(r['id'] in current and state(current[r['id']]) == expected[r['id']] for r in refs):
                return current
            if not refreshed and self.query is not None and any(r['id'] not in current for r in refs):
                # Gmail sometimes optimistically removes archived/deleted search rows
                # even for in:anywhere. Re-query the same set/page, never re-click.
                page, query = self.page, self.query
                self.search(query + ' in:anywhere')
                for _ in range(1, page):
                    if not self.older(): raise GmailError('page_changed_after_mutation')
                refreshed = True
            # Observe only. Never repeat the mutation click.
            time.sleep(.3)
        raise GmailError('mutation_uncertain', 'The operation was clicked but its result is uncertain. Verify; do not repeat it blindly.')


def steps(entries, current):
    """Build idempotent mechanical steps for one visible page; no classification."""
    result = []
    for field, kind in (('add_labels', 'add_label'), ('remove_labels', 'remove_label')):
        for label in sorted({v for e in entries for v in e['change'][field]}):
            ids = [e['row']['id'] for e in entries if label in e['change'][field]
                   and ((label not in current[e['row']['id']]['labels']) if kind == 'add_label'
                        else (label in current[e['row']['id']]['labels']))]
            if ids:
                result.append((kind, label, ids))
    for read, kind in ((True, 'read'), (False, 'unread')):
        ids = [e['row']['id'] for e in entries if e['change'].get('read') is read and current[e['row']['id']]['unread'] is read]
        if ids:
            result.append((kind, None, ids))
    for destination in ('archive', 'inbox', 'not_spam', 'trash'):
        ids = []
        for entry in entries:
            rid = entry['row']['id']
            if entry['change'].get('destination') != destination:
                continue
            labels = current[rid]['labels']
            needed = {'archive': 'Inbox' in labels, 'inbox': 'Inbox' not in labels,
                      'not_spam': 'Spam' in labels, 'trash': 'Trash' not in labels}[destination]
            if needed:
                ids.append(rid)
        if ids:
            result.append((destination, None, ids))
    return result


def advance(before, kind, label=None):
    value = dict(unread=before['unread'], labels=list(before['labels']))
    labels = set(value['labels'])
    if kind == 'add_label': labels.add(label)
    elif kind == 'remove_label': labels.discard(label)
    elif kind == 'read': value['unread'] = False
    elif kind == 'unread': value['unread'] = True
    elif kind == 'archive': labels.discard('Inbox')
    elif kind == 'inbox': labels.add('Inbox')
    elif kind == 'not_spam': labels.discard('Spam'); labels.add('Inbox')
    elif kind == 'trash': labels.discard('Inbox'); labels.discard('Spam'); labels.add('Trash')
    else: raise GmailError('unsupported_step')
    value['labels'] = sorted(labels)
    return value


def apply_plan(ui, entries):
    refs = [e['row'] for e in entries]
    fresh = {r['id']: r for r in ui.collect(refs)}
    for entry in entries:
        current = state(fresh[entry['row']['id']])
        if current not in (entry['before'], entry['after']):
            raise GmailError('precondition_changed', 'State changed after plan preparation. Prepare a new plan.')
    expected = {rid: state(row) for rid, row in fresh.items()}
    ui.search(lookup_query(refs))
    processed, journal = set(), []
    try:
        for page in range(20):
            visible = {r['id']: r for r in ui.rows()['rows']}
            pending = [e for e in entries if e['row']['id'] in visible and e['row']['id'] not in processed]
            for entry in pending:
                rid = entry['row']['id']
                if identity(visible[rid]) != identity(entry['row']) or state(visible[rid]) != expected[rid]:
                    raise GmailError('precondition_changed')
            for kind, label, ids in steps(pending, visible):
                # Validate every target immediately before each selection/click.
                current = {r['id']: r for r in ui.rows()['rows']}
                targets = []
                for rid in ids:
                    if rid not in current or identity(current[rid]) != identity(fresh[rid]) or state(current[rid]) != expected[rid]:
                        raise GmailError('precondition_changed')
                    targets.append(dict(current[rid], expected=expected[rid]))
                intended = {rid: advance(expected[rid], kind, label) for rid in ids}
                journal.append({'operation': kind, 'count': len(ids), 'status': 'attempting'})
                ui.mutate(kind, targets, label)
                ui.finish_mutation(targets, intended)
                expected.update(intended)
                journal[-1]['status'] = 'verified'
            processed.update(e['row']['id'] for e in pending)
            if len(processed) == len(entries):
                break
            if not ui.older():
                raise GmailError('targets_missing_after_mutation')
        if len(processed) != len(entries):
            raise GmailError('pagination_limit')
        # Refresh from Gmail search, rather than trusting optimistic rows or counters.
        final = {r['id']: r for r in ui.collect(refs)}
        report = [{'n': e['change']['n'], 'ok': identity(final[e['row']['id']]) == identity(e['row'])
                   and state(final[e['row']['id']]) == e['after']} for e in entries]
        return {'ok': all(r['ok'] for r in report), 'results': report, 'journal': journal}
    except Exception as exc:
        return {'ok': False, 'error': getattr(exc, 'code', 'apply_interrupted'),
                'message': 'Execution stopped. Some steps may have completed; verify before preparing a new plan.',
                'report': {'journal': journal, 'processed_count': len(processed), 'uncertain': True}}


def connect(request, helpers):
    account = request['account'].lower()
    tabs = helpers['list_tabs']()
    candidates = [t for t in tabs if urlparse(t.get('url', '')).hostname == 'mail.google.com'
                  and re.fullmatch(r'/mail/u/\d+/', urlparse(t['url']).path)
                  and (not request.get('tab_id') or t.get('targetId') == request['tab_id'])]
    if not request.get('tab_id'):
        matching = [t for t in candidates if account in t.get('title', '').lower()]
        candidates = matching if matching else candidates
    if len(candidates) != 1:
        raise GmailError('ambiguous_tab', 'Specify tab_id for an existing Gmail tab; no tab or browser will be opened by this adapter.')
    tab = candidates[0]
    helpers['switch_tab'](tab['targetId'])
    connection = {'account': account, 'tab_id': tab['targetId'], 'base_path': urlparse(tab['url']).path}
    GmailUI(helpers, connection).guard()
    return {'ok': True, 'connection': connection}


def dispatch(request, helpers):
    if request['op'] == 'connect':
        return connect(request, helpers)
    connection = request['connection']
    tabs = helpers['list_tabs']()
    matches = [t for t in tabs if t.get('targetId') == connection['tab_id']]
    if len(matches) != 1:
        raise GmailError('tab_closed', 'Stored Gmail tab is gone. Reconnect explicitly; no substitute account was chosen.')
    helpers['switch_tab'](connection['tab_id'])
    ui = GmailUI(helpers, connection)
    ui.guard()
    op = request['op']
    if op == 'scan':
        ui.snippets = request.get('snippets', False)
        query = request['query']
        result = ui.search(query)
        page, offset = request.get('page', 1), request.get('offset', 0)
        for _ in range(1, page):
            if not ui.older(): raise GmailError('page_unavailable')
        result = ui.rows()
        token = hashlib.sha256(json.dumps([identity(r) for r in result['rows']], ensure_ascii=True).encode()).hexdigest()
        if offset and request.get('page_token') != token:
            raise GmailError('cursor_stale', 'List changed. Restart the scan from page 1 rather than skipping conversations.')
        if offset > len(result['rows']): raise GmailError('cursor_stale')
        rows, current_page, next_cursor = [], page, None
        for _ in range(request.get('max_pages', 5)):
            page_rows = ui.rows()['rows']
            token = hashlib.sha256(json.dumps([identity(r) for r in page_rows], ensure_ascii=True).encode()).hexdigest()
            take = min(request['limit'] - len(rows), len(page_rows) - offset)
            rows.extend(page_rows[offset:offset + take])
            if len(rows) == request['limit']:
                if offset + take < len(page_rows): next_cursor = {'page': current_page, 'offset': offset + take, 'page_token': token}
                else:
                    nodes = ui.nodes('button', ['Older'])
                    if len(nodes) == 1 and not any(p.get('name') == 'disabled' and p.get('value', {}).get('value') is True for p in nodes[0].get('properties', [])):
                        next_cursor = {'page': current_page + 1, 'offset': 0}
                break
            if not ui.older(): break
            current_page += 1
            offset = 0
        else:
            next_cursor = {'page': current_page, 'offset': offset}
        return {'ok': True, 'query': query, 'page': page, 'next_page': next_cursor, 'rows': rows}
    if op in ('lookup', 'verify'):
        rows = ui.collect(request['refs'])
        return {'ok': True, 'rows': rows}
    if op == 'inspect':
        ref = request['ref']
        rows = ui.collect([ref])
        actual = rows[0]
        opened = False
        start_hash = ui.guard()['hash']
        try:
            ui.dom('open', ref=dict(actual, expected=state(actual)), allow_mark_read=request.get('allow_mark_read', False))
            opened = True
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                opened_hash = ui.guard()['hash']
                if opened_hash.startswith(start_hash + '/'):
                    break
                time.sleep(.2)
            else:
                raise GmailError('opened_view_unverifiable')
            time.sleep(.4)
            body = ui.dom('body', ref=actual, expected_hash=opened_hash, max_chars=request.get('max_chars', 6000))
            return {'ok': True, **body, 'marked_read': actual['unread']}
        except Exception as exc:
            if opened:
                exc.report = {'opened': True, 'may_have_marked_read': actual['unread']}
            raise
        finally:
            if opened:
                # Do not obscure an inspection error/side-effect report with a navigation error.
                try: ui.search(lookup_query([ref]))
                except Exception: pass
    if op == 'apply':
        result = apply_plan(ui, request['entries'])
        return result
    raise GmailError('unknown_operation')
