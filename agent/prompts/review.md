---
description: Review work for concrete, prioritized findings
argument-hint: "[scope]"
---

Review ${ARGUMENTS:-the work established in the current discussion}.

- Review for the simplest readable, idiomatic solution that satisfies the requirements. Don't favor fewer lines over clarity.
- Check that the scope stays focused. Prefer direct solutions over speculative abstractions.
- Require a concrete need or risk in the current task for abstractions, dependencies, checks, fallbacks, and tests. When requirements are ambiguous, ask for the assumption to be stated rather than code for every interpretation.
- Flag redundant checks of contracts already guaranteed by types, callers, or other layers. Flag failures that are silently masked.
- Treat unjustified complexity as a defect. Every requested addition must cite a concrete need or risk.

Do not modify files or initiate orchestration.
