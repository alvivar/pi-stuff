---
description: Run the goal loop for the current work
argument-hint: "[goal]"
---

Follow the `pi-link-goal-loop` skill. The goal is ${ARGUMENTS:-the work established in the current discussion}; ask if it is unclear.

Between tasks, compact any agent over 200k of context, with instructions on what to preserve.

Include these principles in every TASK and REVIEW:

- Write the simplest readable, idiomatic code that satisfies the requirements. Don't favor fewer lines over clarity.
- Add abstractions, dependencies, checks, fallbacks, and tests only for a concrete need or risk in the current task. When requirements are ambiguous, state your assumption instead of coding for every interpretation.
- Don't re-check contracts already guaranteed by types, callers, or other layers. Never silently mask failures.
- Reviewers: treat unjustified complexity as a defect, and justify every addition you request.
