# Plan: Expose terminal cwd in link_list

## Goal

Show each terminal's working directory in `link_list` so agents can make better delegation decisions — pick the right target, use explicit paths when cwds differ, catch wrong-project mistakes.

Cwd is a **coordination hint**, not proof of shared workspace, branch, or file access.

## Non-goals

- Not a workspace identity / shared-access system
- Not a general metadata framework
- Not a cwd-change notification to the LLM (silent state update only)

---

## Batch 1 — Protocol, State & Lifecycle

### Protocol changes

Add optional fields to existing messages + one new message type.

**Modified messages:**

```ts
interface RegisterMsg {
  type: "register";
  name: string;
  cwd?: string; // NEW
}

interface WelcomeMsg {
  type: "welcome";
  name: string;
  terminals: string[];
  statuses?: Record<string, LinkStatus>;
  cwds?: Record<string, string>; // NEW: name → absolute cwd
}

interface TerminalJoinedMsg {
  type: "terminal_joined";
  name: string;
  terminals: string[];
  cwd?: string; // NEW: the joiner's cwd
}
```

**New message:**

```ts
interface CwdUpdateMsg {
  type: "cwd_update";
  name: string;
  cwd: string;
}
```

All new fields are optional → old peers ignore them, new peers tolerate their absence.

### State additions

```ts
let currentCwd = ""; // local truth (self)
const terminalCwds = new Map<string, string>(); // client-side, other terminals
const hubTerminalCwds = new Map<string, string>(); // hub-side, authoritative (excludes self)
```

Parallels existing pattern: `terminalStatuses` / `hubTerminalStatuses`.

Self cwd always comes from `currentCwd`, never stored in `hubTerminalCwds`. This mirrors how status works — self is special-cased.

### Hub handling

**On `register`:**

- Store `msg.cwd` in `hubTerminalCwds` if present
- Build `welcome.cwds` from hub's `currentCwd` + all `hubTerminalCwds` entries (excluding the registering client — it already knows its own cwd)
- Include `cwd` in `terminal_joined` broadcast to other clients

**On `cwd_update` from client:**

- Update `hubTerminalCwds`
- Relay `cwd_update` to all other clients (same pattern as `status_update` relay)

**On client disconnect/removal:**

- Delete from `hubTerminalCwds`

### Client handling

**On `welcome`:**

- **Clear `terminalCwds` first** (prevents stale data from previous connection / topology change)
- Populate `terminalCwds` from `msg.cwds` if present

**On `terminal_joined`:**

- Store `msg.cwd` in `terminalCwds` if present

**On `terminal_left`:**

- Delete from `terminalCwds`

**On `cwd_update`:**

- Update `terminalCwds`

### Cleanup

**`disconnect()`:**

- Clear `terminalCwds`
- Clear `hubTerminalCwds`
- (Mirrors existing cleanup of `terminalStatuses` / `hubTerminalStatuses`)

### Lifecycle hooks

**`session_start`:**

```ts
currentCwd = ctx.cwd;
```

**`session_switch` — restructured to handle cwd independently of name:**

The current code has an early return when `desiredName === terminalName`. Cwd logic must run independently of that.

Full matrix:

| Name changed?       | Cwd changed? | Action                                                                   |
| ------------------- | ------------ | ------------------------------------------------------------------------ |
| No                  | No           | Return (no-op)                                                           |
| No                  | Yes          | Update `currentCwd`, push `cwd_update`                                   |
| Yes                 | Either       | Update `currentCwd`, then existing rename/reconnect flow                 |
| Yes (hub, rejected) | Yes          | Keep old name, update `currentCwd`, push `cwd_update` under current name |
| Yes (hub, rejected) | No           | Keep old name, no-op (existing behavior)                                 |

The critical case: hub `session_switch` where the desired name is taken. Current code returns early on rejection. With cwd support, the rejection branch must still check for cwd changes and push `cwd_update` if needed.

```ts
pi.on("session_switch", async (_event, ctx) => {
  // 1. Cwd change detection (always, before any name logic)
  const newCwd = ctx.cwd;
  const cwdChanged = newCwd !== currentCwd;
  if (cwdChanged) currentCwd = newCwd;

  // 2. Existing preferred name / desiredName logic
  // ...
  const nameChanged = desiredName !== terminalName;

  if (!nameChanged) {
    // Name stayed the same — push cwd if it changed
    if (cwdChanged) pushCwdUpdate();
    return;
  }

  // 3. Name changed — existing rename/reconnect flow
  // For client: reconnect with register (includes currentCwd)
  // For hub: in-place rename with terminal_left + terminal_joined(cwd)
  //   If hub rename rejected (name taken):
  //     if (cwdChanged) pushCwdUpdate();  // still publish cwd under old name
  //     return;
});
```

Helper:

```ts
function pushCwdUpdate() {
  const msg = { type: "cwd_update", name: terminalName, cwd: currentCwd };
  if (role === "hub") {
    hubBroadcast(msg);
  } else if (role === "client" && ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}
```

**Connect / register:**

- `connectAsClient()`: include `currentCwd` in the `register` message
- Automatic reconnect after hub loss uses the same `register` path, so cwd is re-sent automatically
- If a disconnected client becomes hub, `currentCwd` is already set and seeds hub state

### Rename flows (both `/link-name` and `session_switch`)

Hub has two in-place rename paths — both broadcast `terminal_left` + `terminal_joined`. Both must include `cwd` in `terminal_joined`:

```ts
hubBroadcast({
  type: "terminal_joined",
  name: newName,
  terminals: list,
  cwd: currentCwd,
});
```

Client rename reconnects via `register`, which already includes cwd from the lifecycle hook above.

---

## Batch 2 — link_list display

### Helper: getCwdFor

```ts
function getCwdFor(name: string): string | null {
  if (name === terminalName) return currentCwd || null;
  if (role === "hub") return hubTerminalCwds.get(name) ?? null;
  return terminalCwds.get(name) ?? null;
}
```

### Helper: shortenPath

```ts
function shortenPath(cwd: string): string {
  const home = os.homedir().replace(/\\/g, "/");
  const normalized = cwd.replace(/\\/g, "/");
  if (normalized === home) return "~";
  if (normalized.startsWith(home + "/"))
    return "~" + normalized.slice(home.length);
  return normalized;
}
```

### Tool result details

Add `cwds` to details. Raw details keep **full absolute paths**:

```ts
const cwds: Record<string, string> = {};
for (const name of connectedTerminals) {
  const cwd = getCwdFor(name);
  if (cwd) cwds[name] = cwd;
}

return textResult(`Connected terminals:\n${list}`, {
  terminals: connectedTerminals,
  statuses,
  cwds,
  self: terminalName,
  role,
});
```

### Text result (LLM-facing)

Second indented line per terminal, **shortened path** for readability:

```
Connected terminals:
  • opus@pi-link (you)  idle (12s)
    cwd: ~/src/pi-link
  • gpt@pi-link  thinking (3s)
    cwd: ~/src/pi-link
  • docs@pi-link  idle (1m)
    cwd: ~/.pi/docs
```

Only show cwd line if cwd is known (graceful for old terminals).

Note: the text result (LLM-facing) uses **full absolute paths** for precision. Only the TUI renderer and `/link` notification use shortened paths.

### TUI rendered result

Same layout — second indented line with **shortened path**, dimmed color.

### `/link` command

Include shortened cwd in the notification output for consistency.

---

## Compatibility

| Scenario              | Behavior                                                            |
| --------------------- | ------------------------------------------------------------------- |
| All terminals updated | Full cwd visibility                                                 |
| Old client, new hub   | Hub stores no cwd for old client; `link_list` omits cwd line for it |
| New client, old hub   | Hub ignores `register.cwd`; client gets no `cwds` in welcome        |
| Mixed                 | Cwd shown where available, absent otherwise                         |

No breaking changes. All new fields optional. Unknown message types already ignored.

---

## Files changed

- `index.ts` — protocol types, state, hub/client handling, lifecycle hooks, link_list, /link

## Estimated size

~80–100 lines of new/modified code across both batches.

## Risk

Low. Additive feature, no existing behavior changes, optional protocol fields.

## Testing

Add to TEST.md:

- Scenario: Two terminals in different cwds → `link_list` shows both cwds
- Scenario: Session switch changes cwd but not name → cwd updates for all terminals
- Scenario: Session switch changes both name and cwd → cwd correct after rename
- Scenario: Hub session_switch rename rejected (name taken) + cwd changed → cwd still updates
- Scenario: Mixed old/new terminals → cwd absent gracefully for old terminals
- Scenario: Hub `/link-name` rename → clients see new name with preserved cwd
- Scenario: Reconnect after hub loss → cwd re-sent with new register
