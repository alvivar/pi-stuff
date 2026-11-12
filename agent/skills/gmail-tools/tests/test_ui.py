import copy
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from gmail_backend import DOM, GmailUI, advance, identity, state
from test_backend import row


class Helpers:
    """Synthetic DOM/AX lane for exercising the real GmailUI control sequence."""
    def __init__(self, values, auto_apply=True, clear_after_action=False):
        self.values = copy.deepcopy(values)
        self.selected = []
        self.menu = None
        self.pending = False
        self.auto_apply = auto_apply
        self.clear_after_action = clear_after_action
        self.names = {}
        self.clicks = []

    def request(self, op):
        if op == 'account': return dict(account='person@example.com', base_path='/mail/u/0/', hash='#search/test')
        raise ValueError(op)

    def js(self, expression):
        req = json.loads(expression[len(DOM) + 3:-1])
        op = req['op']
        if op == 'account': return self.request(op)
        if op == 'assert_clear':
            if self.selected: raise RuntimeError('GMAIL_EXISTING_SELECTION')
            return {'clear': True}
        if op == 'rows':
            if self.selected: raise RuntimeError('GMAIL_EXISTING_SELECTION')
            return {'rows': copy.deepcopy(self.values), 'hash': '#search/test', 'empty': False, 'busy': False}
        refs = req['refs']
        ids = [r['id'] for r in refs]
        for ref in refs:
            matches = [r for r in self.values if r['id'] == ref['id']]
            if len(matches) != 1 or identity(matches[0]) != identity(ref): raise RuntimeError('GMAIL_REVISION_CHANGED')
            if op != 'deselect' and state(matches[0]) != ref['expected']: raise RuntimeError('GMAIL_STATE_CHANGED')
        if op == 'select':
            if self.selected: raise RuntimeError('GMAIL_EXISTING_SELECTION')
            self.selected = ids
        elif op == 'check_selection':
            if set(self.selected) != set(ids): raise RuntimeError('GMAIL_SELECTION_MISMATCH')
        elif op == 'deselect':
            if any(rid not in ids for rid in self.selected): raise RuntimeError('GMAIL_SELECTION_MISMATCH')
            self.selected = []
        else: raise ValueError(op)
        return {'count': len(self.selected)}

    def node(self, role, name, properties=None):
        rid = len(self.names) + 1
        self.names[rid] = (role, name)
        return dict(role={'value': role}, name={'value': name}, backendDOMNodeId=rid,
                    properties=properties or [], ignored=False)

    def cdp(self, method, **kwargs):
        if method == 'DOM.getBoxModel':
            rid = kwargs['backendNodeId']
            return {'model': {'content': [rid, 1, rid, 1, rid, 1, rid, 1]}}
        if method != 'Accessibility.getFullAXTree': raise ValueError(method)
        if self.menu == 'labels':
            checked = 'true' if all('Example' in r['labels'] for r in self.values if r['id'] in self.selected) else 'false'
            nodes = [self.node('menuitemcheckbox', 'Example', [dict(name='checked', value={'value': checked})])]
            if self.pending: nodes.append(self.node('button', 'Apply'))
        elif self.menu == 'move': nodes = [self.node('menuitem', 'Inbox')]
        elif self.menu == 'more': nodes = [self.node('menuitem', 'Not spam')]
        else:
            nodes = [self.node('button', name) for name in ['Labels', 'Mark as read', 'Mark as unread', 'Archive', 'Delete', 'Move to', 'More email options']]
        return {'nodes': nodes}

    def edit(self, kind, label=None):
        for r in self.values:
            if r['id'] in self.selected: r.update(advance(state(r), kind, label))
        self.menu = None
        if self.clear_after_action: self.selected = []

    def click_at_xy(self, x, y):
        role, name = self.names[int(x)]
        self.clicks.append(name)
        if name == 'Labels': self.menu = 'labels'
        elif name == 'Example':
            self.label_kind = 'remove_label' if all('Example' in r['labels'] for r in self.values if r['id'] in self.selected) else 'add_label'
            if self.auto_apply: self.edit(self.label_kind, 'Example')
            else: self.pending = True
        elif name == 'Apply': self.edit(self.label_kind, 'Example'); self.pending = False
        elif name == 'Move to': self.menu = 'move'
        elif name == 'More email options': self.menu = 'more'
        else:
            kind = {'Mark as read': 'read', 'Mark as unread': 'unread', 'Archive': 'archive',
                    'Delete': 'trash', 'Inbox': 'inbox', 'Not spam': 'not_spam'}[name]
            self.edit(kind)

    def exports(self):
        return dict(js=self.js, cdp=self.cdp, click_at_xy=self.click_at_xy)


class UIControlTests(unittest.TestCase):
    def exercise(self, kind, initial=None, label=None, **kwargs):
        original = row(1, **(initial or {}))
        untouched = row(2)
        helpers = Helpers([original, untouched], **kwargs)
        ui = GmailUI(helpers.exports(), dict(account='person@example.com', tab_id='abc', base_path='/mail/u/0/'))
        ref = dict(original, expected=state(original))
        expected = {ref['id']: advance(state(original), kind, label)}
        with patch('gmail_backend.time.sleep', lambda _: None):
            ui.mutate(kind, [ref], label)
            ui.finish_mutation([ref], expected)
        self.assertEqual(state(helpers.values[0]), expected[ref['id']])
        self.assertEqual(helpers.values[1], untouched)
        self.assertEqual(helpers.selected, [])
        return helpers

    def test_label_menu_auto_apply(self):
        self.assertNotIn('Apply', self.exercise('add_label', label='Example').clicks)

    def test_label_menu_explicit_apply(self):
        self.assertIn('Apply', self.exercise('add_label', label='Example', auto_apply=False).clicks)

    def test_remove_label(self):
        self.exercise('remove_label', initial={'labels': ['Example', 'Inbox']}, label='Example')

    def test_state_operations_with_persisting_or_cleared_selection(self):
        cases = [('read', None), ('unread', {'unread': False}), ('archive', None), ('trash', None),
                 ('inbox', {'labels': []}), ('not_spam', {'labels': ['Spam']})]
        for kind, initial in cases:
            for clear in (False, True):
                with self.subTest(kind=kind, clear=clear):
                    self.exercise(kind, initial=initial, clear_after_action=clear)

    def test_disappearing_processed_search_row_is_refreshed_without_reclick(self):
        original = row()
        helpers = Helpers([original])
        ui = GmailUI(helpers.exports(), dict(account='person@example.com', tab_id='abc', base_path='/mail/u/0/'))
        ref = dict(original, expected=state(original))
        refreshed = []
        with patch('gmail_backend.time.sleep', lambda _: None):
            ui.mutate('trash', [ref])
            ui.query = 'in:anywhere synthetic'
            ui.rows = lambda: {'rows': copy.deepcopy(helpers.values) if refreshed else []}
            def refresh(query):
                refreshed.append(query)
                ui.query, ui.page = query, 1
                return ui.rows()
            ui.search = refresh
            ui.finish_mutation([ref], {ref['id']: advance(state(original), 'trash')})
        self.assertEqual(helpers.clicks.count('Delete'), 1)
        self.assertEqual(len(refreshed), 1)

    def test_missing_label_causes_no_mailbox_change(self):
        original = row()
        helpers = Helpers([original])
        ui = GmailUI(helpers.exports(), dict(account='person@example.com', tab_id='abc', base_path='/mail/u/0/'))
        with patch('gmail_backend.time.sleep', lambda _: None):
            with self.assertRaises(Exception):
                ui.mutate('add_label', [dict(original, expected=state(original))], 'Missing')
        self.assertEqual(helpers.values, [original])


if __name__ == '__main__': unittest.main()
