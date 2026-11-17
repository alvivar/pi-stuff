---
description: Propose the minimal implementation that meets the goal
argument-hint: "[work]"
---

Propose the minimal implementation for ${ARGUMENTS:-the work established in the current discussion}.

- Start from the original goal and what already exists. Question the need for new architecture before refining it.
- Aim for the simplest readable, idiomatic code that satisfies the requirements. Don't favor fewer lines over clarity.
- Include abstractions, dependencies, checks, fallbacks, and tests only for a concrete need or risk in the current task. When requirements are ambiguous, state the assumption rather than covering every interpretation.
- Rely on contracts already guaranteed by types, callers, or other layers. Never silently mask failures.
- Justify every addition you propose.

State what you actually checked.

Do not modify files or initiate orchestration.
