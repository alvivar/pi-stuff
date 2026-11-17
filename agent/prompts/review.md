---
description: Review work for unjustified complexity
argument-hint: "[work]"
---

Review ${ARGUMENTS:-the work established in the current discussion}.

- Review for the simplest readable, idiomatic solution that satisfies the requirements. Don't favor fewer lines over clarity.
- Check that the scope stays focused.
- Require a concrete need or risk in the current task for abstractions, dependencies, checks, fallbacks, and tests. When requirements are ambiguous, ask for the assumption to be stated rather than code for every interpretation.
- Flag redundant checks of contracts already guaranteed by types, callers, or other layers. Flag failures that are silently masked.
- Treat unjustified complexity as a defect, and justify every addition you request.

State what you actually checked.

Do not modify files or initiate orchestration.
