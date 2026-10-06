---
description: Review a change or code scope for concrete, prioritized findings
argument-hint: "[scope]"
---

Review $ARGUMENTS. If no scope is supplied, use the change or scope established in the current discussion; ask if it is unclear.

Inspect the actual code and diff, including relevant new files, against the requirements. Prefer readable, idiomatic, direct solutions; do not trade clarity for fewer lines. Require a concrete need or risk to justify additional complexity.

Prioritize concrete findings. For each, identify where it occurs, why it matters, and the recommended correction. Separate necessary fixes from optional improvements and unverified concerns. Check whether available verification exercises the changed behavior, and state what you could not verify. Do not invent changes to fill the report; if there are no relevant findings, say so.

Review only. Do not modify files or initiate orchestration.
