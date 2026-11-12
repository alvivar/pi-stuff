# Gmail tools: a self-contained skill

Everything is in this directory:
- SKILL.md: mechanical operating instructions
- scripts/: CLI, state handling, browser-use adapter and DOM operations
- references/: operation contract
- tests/: synthetic/offline tests
- .state/: private runtime metadata (gitignored; do not share)

No files/loaders in extensions/, no registered Pi tools and no settings changes.
Pi's documented skill-with-scripts pattern is used. Load with /skill:gmail-tools
(after /reload if the skill was just added/edited). Invoke scripts through bash.

Requires Node.js 22.19+, browser-use on PATH, and an existing signed-in local
Gmail tab using the English interface. No npm dependencies, OAuth or API keys.

  node scripts/gmail.mjs --help
  node --test tests/*.test.mjs
  python -m unittest discover -s tests -p 'test_*.py'

The CLI reads JSON stdin and emits JSON stdout. Operations:
connect, scan, inspect, prepare, apply, verify, batch.

Authorization is determined in the conversation. apply requires --confirm with
the exact prepared digest as explicit caller acknowledgment, not human identity
proof. There is no extension-owned Pi UI confirmation dialog.

Tests use synthetic mail and injected fake browser adapters. Live smoke tests
must remain read-only: connect/scan/prepare/verify, never apply/inspect personal
mail to test mutations. The skill has no personal organization rules.

Runtime state is per PI_SESSION_ID (or explicit --session outside Pi). It is
not Pi-branch-relative and is not stored in Pi session files. Compaction/reload
preserves it; Pi tree navigation does not roll it back or undo Gmail changes.
