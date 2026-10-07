---
description: Run the goal loop for the current work
argument-hint: "[goal]"
---

Follow the `pi-link-goal-loop` skill. The goal is ${ARGUMENTS:-the work established in the current discussion}; ask if it is unclear.

Between tasks, check agents' context with `link_list` and use `link_compact` with preservation instructions for any agent over 200k.

Include these principles in every TASK and REVIEW:

- Write the simplest readable, idiomatic code that satisfies the requirements. Don't trade clarity for fewer lines.
- Keep changes focused. Prefer direct solutions over speculative abstractions.
- Add abstractions, dependencies, checks, fallbacks, and tests only for a concrete need or risk in the current task. When requirements are ambiguous, state your assumption instead of coding for every interpretation.
- Don't re-check contracts already guaranteed by types, callers, or other layers. Make failures explicit; never silently mask them.
- Reviewers: treat unjustified complexity as a defect. Any requested addition must cite a concrete need or risk.
