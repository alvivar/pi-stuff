---
name: pi-link-tools
description: "How to coordinate with other Pi terminals over pi-link. Use when sending messages, waiting for replies or requesting compaction."
---

# Pi-Link Tools

- Include the context the other terminal needs; it does not receive your conversation automatically. When location matters, give explicit paths or the intended cwd: naming a path does not change the receiver's cwd.
- Your ordinary reply stays in your own conversation; send results with `link_send` to the requester or the designated recipient.
- A successful send is not proof of receipt or of completed work. Ask for a reply when you need confirmation, say who should receive it, and label concurrent exchanges when needed.
- If all that remains is waiting, end your turn instead of sleeping or polling `link_list`; continue useful work if you have it.
- Do not reply just to acknowledge an acknowledgment: each delivered message starts or steers work.
- Use the exact terminal names from `link_list`. Groups filter visibility; they are not access or trust boundaries.
- Terminals may share files and pi-link does not lock them: agree who edits before concurrent changes.

Compaction:

- `instructions` say what the summary should preserve; they are not a task. Have details that matter written down or reported first: `instructions` do not guarantee what survives.
- Idle is observed, not reserved: work that starts as compaction begins can still be interrupted.
- There is no remote cancel: leaving does not undo a request the target holds. Reloading or exiting loses tracking of pending outcomes, renaming can lose responses, and `link_list` cannot recover a lost result.
