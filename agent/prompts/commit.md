---
description: Commit uncommitted changes
argument-hint: "[scope]"
---

Commit ${ARGUMENTS:-all uncommitted changes} as focused commits with meaningful messages, grouping related changes so the Git history tells a clear, reviewable story. Inspect the actual status and diff first, including untracked and already staged files. Commit by explicit paths and leave changes outside the scope untouched; ask about anything that looks unintended. Do not push, amend, or rewrite history unless explicitly asked. Report the commit hashes.
