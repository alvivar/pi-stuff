---
description: Review a change or code scope for concrete, prioritized findings
argument-hint: "[scope]"
---

Review $ARGUMENTS. If no scope is supplied, use the change or scope established in the current discussion; ask if it is unclear.

- Review for the simplest readable, idiomatic code that satisfies the requirements. Don't favor fewer lines over clarity.
- Check that changes stay focused. Prefer direct solutions over speculative abstractions.
- Require a concrete need or risk in the current task for abstractions, dependencies, checks, fallbacks, and tests. When requirements are ambiguous, ask for the assumption to be stated rather than code for every interpretation.
- Flag redundant checks of contracts already guaranteed by types, callers, or other layers. Ensure failures are explicit and never silently masked.
- Treat unjustified complexity as a defect. Every requested addition must cite a concrete need or risk.

Review only. Do not modify files or initiate orchestration.
