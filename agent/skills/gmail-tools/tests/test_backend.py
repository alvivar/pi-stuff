import copy
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from gmail_backend import GmailError, GmailUI, advance, dispatch, apply_plan, identity, lookup_query, state, steps


def row(i=1, **kwargs):
    value = dict(id=f'{i:016x}', sender='sender@example.org', senders=['sender@example.org'],
                 subject='Synthetic subject', time='Wed, Nov 11, 2026, 1:18 PM',
                 summary='Sender', labels=['Inbox'], unread=True)
    value.update(kwargs)
    return value


def entry(r, n, **change):
    change = dict(n=n, id=r['id'], add_labels=change.pop('add_labels', []),
                  remove_labels=change.pop('remove_labels', []), **change)
    value = state(r)
    for label in change['add_labels']: value = advance(value, 'add_label', label)
    for label in change['remove_labels']: value = advance(value, 'remove_label', label)
    if 'read' in change: value = advance(value, 'read' if change['read'] else 'unread')
    if 'destination' in change: value = advance(value, change['destination'])
    return dict(row=copy.deepcopy(r), change=change, before=state(r), after=value)


class FakeUI:
    def __init__(self, rows, page_size=2):
        self.data = copy.deepcopy(rows)
        self.page, self.page_size, self.calls, self.fail = 0, page_size, [], False

    def collect(self, refs, max_pages=20):
        return [copy.deepcopy(r) for r in self.data if r['id'] in {v['id'] for v in refs}]

    def search(self, query):
        self.page = 0
        return self.rows()

    def rows(self):
        start = self.page * self.page_size
        return {'rows': copy.deepcopy(self.data[start:start + self.page_size])}

    def older(self):
        if (self.page + 1) * self.page_size >= len(self.data): return False
        self.page += 1
        return True

    def mutate(self, kind, refs, label=None):
        self.calls.append((kind, [r['id'] for r in refs], label))
        for ref in refs:
            target = next(r for r in self.data if r['id'] == ref['id'])
            if state(target) != ref['expected']: raise GmailError('state_changed')
            target.update(advance(state(target), kind, label))
        if self.fail: raise GmailError('connection_lost')

    def finish_mutation(self, refs, expected):
        for ref in refs:
            actual = next(r for r in self.data if r['id'] == ref['id'])
            if state(actual) != expected[ref['id']]: raise GmailError('mutation_uncertain')


class BackendTests(unittest.TestCase):
    def test_paginated_grouped_apply_preserves_omitted_conversations(self):
        rows = [row(i) for i in range(1, 7)]
        entries = [entry(rows[0], 1, read=True, destination='archive', add_labels=['Example']),
                   entry(rows[2], 3, destination='trash'),
                   entry(rows[5], 6, read=True, destination='archive')]
        ui = FakeUI(rows)
        report = apply_plan(ui, entries)
        self.assertTrue(report['ok'], report)
        for i in [1, 3, 4]:
            self.assertEqual(ui.data[i], rows[i])
        for e in entries:
            self.assertEqual(state(next(r for r in ui.data if r['id'] == e['row']['id'])), e['after'])

    def test_already_satisfied_entry_is_not_clicked(self):
        r = row()
        e = entry(r, 1, read=True, destination='archive')
        ui = FakeUI([dict(r, **e['after'])])
        self.assertTrue(apply_plan(ui, [e])['ok'])
        self.assertEqual(ui.calls, [])

    def test_changed_precondition_causes_zero_mutations(self):
        r = row()
        ui = FakeUI([dict(r, labels=['Inbox', 'Unexpected'])])
        with self.assertRaises(GmailError):
            apply_plan(ui, [entry(r, 1, read=True)])
        self.assertEqual(ui.calls, [])

    def test_ambiguous_transport_failure_is_not_retried(self):
        r = row()
        ui = FakeUI([r])
        ui.fail = True
        report = apply_plan(ui, [entry(r, 1, read=True, destination='archive')])
        self.assertFalse(report['ok'])
        self.assertTrue(report['report']['uncertain'])
        self.assertEqual(len(ui.calls), 1)
        self.assertFalse(ui.data[0]['unread'])
        self.assertIn('Inbox', ui.data[0]['labels'])

    def test_daemon_timeout_reports_uncertain_codes(self):
        # browser-use raises a TimeoutError subclass after a CDP command was already submitted.
        def timeout(*args, **kwargs): raise TimeoutError('Runtime.evaluate timed out after 5s waiting for the daemon')
        ui = GmailUI({'js': timeout}, {'account': 'a@example.org', 'base_path': '/mail/u/0/'})
        with self.assertRaises(GmailError) as caught: ui.guard()
        self.assertEqual(caught.exception.code, 'dom_operation_failed')
        r = row()
        fake = FakeUI([r])
        fake.mutate = timeout
        report = apply_plan(fake, [entry(r, 1, read=True)])
        self.assertEqual(report['error'], 'apply_interrupted')

    def test_read_and_labels_are_not_implicit(self):
        r = row()
        ui = FakeUI([r])
        self.assertTrue(apply_plan(ui, [entry(r, 1, destination='archive')])['ok'])
        self.assertTrue(ui.data[0]['unread'])
        self.assertEqual(ui.data[0]['labels'], [])

    def test_query_is_bounded_and_sender_cannot_inject_search(self):
        query = lookup_query([row()])
        self.assertIn('in:anywhere after:2026/11/09 before:2026/11/13', query)
        with self.assertRaises(GmailError): lookup_query([row(sender='a@example.com} in:anywhere')])
        with self.assertRaises(GmailError): lookup_query([row(time='unsupported')])

    def test_not_spam_and_custom_label_removal(self):
        r = row(labels=['Example', 'Spam'], unread=False)
        ui = FakeUI([r])
        e = entry(r, 1, remove_labels=['Example'], destination='not_spam')
        self.assertTrue(apply_plan(ui, [e])['ok'])
        self.assertEqual(ui.data[0]['labels'], ['Inbox'])
        self.assertFalse(ui.data[0]['unread'])



class InspectCleanupTests(unittest.TestCase):
    def inspect(self, body, cleanup):
        r = row()
        hashes = iter(['#search/q', '#search/q', '#search/q/thread'])
        def dom(ui, op, **kwargs):
            if op == 'body': return body()
        request = {'op': 'inspect', 'ref': r, 'allow_mark_read': True,
                   'connection': {'account': 'a@example.org', 'tab_id': 't', 'base_path': '/mail/u/0/'}}
        helpers = {'list_tabs': lambda: [{'targetId': 't'}], 'switch_tab': lambda tab: None}
        with patch.object(GmailUI, 'collect', lambda ui, refs: [copy.deepcopy(r)]),              patch.object(GmailUI, 'guard', lambda ui: {'hash': next(hashes)}),              patch.object(GmailUI, 'dom', dom),              patch.object(GmailUI, 'search', lambda ui, query: cleanup()),              patch('gmail_backend.time.sleep', lambda _: None):
            return dispatch(request, helpers)

    def test_cleanup_failure_after_successful_inspection_is_reported_with_read_state(self):
        def cleanup(): raise GmailError('account_changed')
        with self.assertRaises(GmailError) as caught:
            self.inspect(lambda: {'text': 'body', 'attachment_names': [], 'truncated': False}, cleanup)
        self.assertEqual(caught.exception.code, 'account_changed')
        self.assertEqual(caught.exception.report, {'opened': True, 'marked_read': True, 'cleanup_error': 'account_changed'})

    def test_cleanup_failure_does_not_replace_inspection_error(self):
        def body(): raise GmailError('body_changed')
        def cleanup(): raise TimeoutError('daemon timeout')
        with self.assertRaises(GmailError) as caught:
            self.inspect(body, cleanup)
        self.assertEqual(caught.exception.code, 'body_changed')
        self.assertEqual(caught.exception.report['cleanup_error'], 'browser_error')


if __name__ == '__main__':
    unittest.main()
