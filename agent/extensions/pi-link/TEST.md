# Manual Test Matrix

Test scenarios for pi-link. Each test lists setup, steps, and expected result.

Pi always starts a **new session** on launch. Persistent names only restore via `/resume` (which triggers `session_switch`). Keep this in mind — `pi --link` alone never restores a saved name.

---

## 1. Flag: off by default

**Setup:** One terminal with pi-link installed.

```
Terminal 1:  pi                        # no --link flag
```

**Expected:**

- No status bar text (no "link: offline", nothing)
- No connection attempt
- `/link` shows "Link: not connected"
- `link_list` returns "Not connected to link"

---

## 2. Flag: --link connects on startup

**Setup:** One terminal.

```
Terminal 1:  pi --link
```

**Expected:**

- Status bar shows `link: <name> (hub) · 1 terminal`
- `/link` shows status with your name
- You became the hub (first terminal on the port)

---

## 3. Two terminals connect

**Setup:** Two terminals.

```
Terminal 1:  pi --link                 # becomes hub
Terminal 2:  pi --link                 # becomes client
```

**Expected:**

- Terminal 1 gets a notification that terminal 2 joined
- Terminal 2 gets a notification showing its name and terminal count
- Both see 2 terminals in `/link` and `link_list`
- Status bar on both updates to show 2 terminals

---

## 4. Mid-session connect without flag

**Setup:** One terminal already running as hub, one plain terminal.

```
Terminal 1:  pi --link                 # hub
Terminal 2:  pi                        # no flag, no connection
Terminal 2:  /link-connect             # manual connect
```

**Expected:**

- Terminal 2 connects as client
- Both see 2 terminals
- Terminal 2 gets a join notification

---

## 5. Manual disconnect suppresses reconnect

**Setup:** Two connected terminals.

```
Terminal 1:  pi --link                 # hub
Terminal 2:  pi --link                 # client
Terminal 2:  /link-disconnect
```

**Expected:**

- Terminal 2 disconnects, shows "Disconnected from link"
- Terminal 1 gets a leave notification
- Terminal 2 does NOT auto-reconnect (even though --link was passed)
- Terminal 2 status bar shows "link: offline"
- `/link-connect` on terminal 2 reconnects

---

## 6. Set link name with /link-name

**Setup:** One connected terminal.

```
Terminal 1:  pi --link
Terminal 1:  /link-name builder
```

**Expected:**

- Renamed to "builder"
- Status bar updates to show "builder"
- Name is persisted to session (saved via appendEntry)

---

## 7. Persistent name restores on /resume

This is the core persistence test. Remember: `pi` starts a new session. The saved name only comes back via `/resume`.

**Setup:** One terminal.

```
Terminal 1:  pi --link
Terminal 1:  /link-name builder
Terminal 1:  /link                     # confirm name is "builder"
Terminal 1:  Ctrl+C                    # exit

Terminal 1:  pi --link                 # NEW session — random name
Terminal 1:  /link                     # confirm name is random t-xxxx
Terminal 1:  /resume                   # pick the session where you set "builder"
```

**Expected:**

- After `/resume`, terminal identity changes to "builder"
- If hub: in-place rename (no reconnect). If client: disconnect and reconnect requesting "builder"
- Status bar shows "builder"
- If "builder" is taken by another terminal, hub assigns "builder-2" — but the saved preference stays "builder"

---

## 8. Preference survives hub conflict

**Setup:** Two terminals.

```
Terminal 1:  pi --link
Terminal 1:  /link-name builder

Terminal 2:  pi --link
Terminal 2:  /link-name builder        # same name requested
```

**Expected:**

- Terminal 2 gets assigned "builder-2" (hub enforces uniqueness)
- Terminal 2's saved preference is still "builder" (not "builder-2")

Now test that the preference retries correctly:

```
Terminal 1:  Ctrl+C                    # "builder" is now free
Terminal 2:  Ctrl+C
Terminal 2:  pi --link
Terminal 2:  /resume                   # pick the session where "builder" was set
```

**Expected:**

- Terminal 2 requests "builder" (the saved preference, not "builder-2")
- Since "builder" is now free, terminal 2 gets "builder"

---

## 9. Unnamed session gets fresh random name

**Setup:** One terminal.

```
Terminal 1:  pi --link                 # never set /link-name
Terminal 1:  /link                     # note the random name, e.g. "t-a3f2"
Terminal 1:  Ctrl+C

Terminal 1:  pi --link                 # new session
Terminal 1:  /link                     # note a different random name, e.g. "t-b7c1"
Terminal 1:  /resume                   # pick the first session (no saved name)
```

**Expected:**

- After resume, terminal gets a NEW random name (not "t-a3f2")
- Unnamed sessions don't persist random names — each connect generates fresh

---

## 10. Session switch while connected

**Setup:** One terminal, two sessions with different names.

```
Terminal 1:  pi --link
Terminal 1:  /link-name alpha
Terminal 1:  /new                      # start new session (stays connected)
Terminal 1:  /link-name beta
Terminal 1:  /resume                   # pick the "alpha" session
```

**Expected:**

- After resume, terminal identity changes to "alpha"
- If hub: in-place rename, no server teardown, other clients see leave/join
- If client: disconnect and reconnect as "alpha"
- `/link` confirms name is "alpha"

---

## 11. Session switch while connected as hub (no teardown)

**Setup:** Two terminals, hub switches session.

```
Terminal 1:  pi --link                 # hub
Terminal 1:  /link-name alpha

Terminal 2:  pi --link                 # client

Terminal 1:  /new
Terminal 1:  /link-name beta
Terminal 1:  /resume                   # pick the "alpha" session
```

**Expected:**

- Terminal 1 renames in-place from "beta" to "alpha"
- Terminal 2 sees a leave ("beta") and join ("alpha") notification
- Terminal 2 stays connected — no disconnection
- Hub server stays running on the same port

---

## 12. Session switch to unnamed session while connected

**Setup:** One connected terminal, two sessions.

```
Terminal 1:  pi --link
Terminal 1:  /link-name alpha          # named session A
Terminal 1:  /new                      # creates unnamed session B
                                       # observe: /new triggers session_switch
                                       # terminal should get a fresh random name immediately
Terminal 1:  /link                     # confirm name is random t-xxxx (not "alpha")
Terminal 1:  /link-name beta           # name session B
Terminal 1:  /resume                   # pick session A ("alpha")
Terminal 1:  /link                     # confirm name is "alpha"
Terminal 1:  /resume                   # pick session B ("beta")
Terminal 1:  /link                     # confirm name is "beta"
```

**Expected:**

- `/new` switches to unnamed session → fresh random name, not the old "alpha"
- Each `/resume` restores that session's saved preferred name
- If hub: in-place rename each time, no server teardown
- If client: disconnect and reconnect each time

---

## 13. /link-name with no args uses session name

**Setup:** One connected terminal.

```
Terminal 1:  pi --link
Terminal 1:  /name my-worker           # set Pi session name
Terminal 1:  /link-name                # no args
```

**Expected:**

- Link name set to "my-worker"
- Preference persisted
- Ctrl+C, then `pi --link`, then `/resume` → restores "my-worker"

---

## 14. /link-name no args with no session name

**Setup:** One connected terminal, no session name set.

```
Terminal 1:  pi --link
Terminal 1:  /link-name                # no args, no session name
```

**Expected:**

- Shows current name and usage hint: `Usage: /link-name <name>`
- No rename, no persistence

---

## 15. Hub rejects /link-name if taken

**Setup:** Two connected terminals.

```
Terminal 1:  pi --link                 # hub
Terminal 1:  /link-name builder

Terminal 2:  pi --link                 # client

Terminal 1:  /link-name <terminal-2-name>    # try to take terminal 2's name
```

**Expected:**

- Hub rejects: "Name is already taken by another terminal"
- No rename happens
- No preference is saved (persist happens after success, not before)

---

## 16. Automatic status in link_list

**Setup:** Two connected terminals.

```
Terminal 1:  pi --link
Terminal 2:  pi --link
```

**Test idle status:**

- Terminal 1 calls `link_list`
- Both terminals should show `idle (Xs)`

**Test thinking status:**

- Terminal 2: send a prompt to the LLM (e.g., "explain recursion")
- Terminal 1: quickly call `link_list` while terminal 2 is thinking
- Terminal 2 should show `thinking (Xs)`

**Test tool status:**

- Terminal 2: ask something that triggers a tool (e.g., "read file X")
- Terminal 1: quickly call `link_list` while tool runs
- Terminal 2 should show `tool:read (Xs)` or `tool:bash (Xs)`

**Test return to idle:**

- After terminal 2 finishes, terminal 1 calls `link_list`
- Terminal 2 should show `idle (Xs)` again

---

## 17. Status on new joiner (welcome sync)

**Setup:** One terminal already working.

```
Terminal 1:  pi --link
Terminal 1:  (ask something, get it thinking/running tools)

Terminal 2:  pi --link                 # joins while terminal 1 is busy
Terminal 2:  (call link_list immediately)
```

**Expected:**

- Terminal 2 sees terminal 1's current status (from welcome snapshot)
- Not blank or fake idle — actual status from the moment of joining

---

## 18. Unknown status renders as blank

**Setup:** Timing-sensitive — a terminal joins but hasn't pushed status yet.

This is hard to trigger manually. The window is between `welcome` receipt and the first `pushStatus(true)`. In practice it's near-instant. If you do see a terminal with no status string in `link_list`, that's correct — it means "no status data yet", not fake idle.

---

## 19. Hub promotion after hub death

**Setup:** Two terminals.

```
Terminal 1:  pi --link                 # hub
Terminal 2:  pi --link                 # client

Terminal 1:  Ctrl+C                    # kill the hub
```

**Expected:**

- Terminal 2 detects disconnect
- After reconnect delay (2-5s), terminal 2 promotes itself to hub
- Status bar shows `(hub)` on terminal 2
- A third terminal can now connect to terminal 2

---

## 20. Client reconnect retries preferred name (not runtime variant)

This tests the `connectAsClient` fix: after getting a hub-assigned variant like "builder-2", a later client reconnect requests the **preferred** name "builder", not the last runtime name.

**Setup:** Two terminals.

```
Terminal 1:  pi --link                 # hub
Terminal 1:  /link-name builder

Terminal 2:  pi --link                 # client
Terminal 2:  /link-name builder        # requests "builder"
                                       # hub assigns "builder-2" (conflict)
Terminal 2:  /link                     # confirm runtime name is "builder-2"

Terminal 1:  /link-name alpha          # hub frees up "builder"

Terminal 2:  /link-disconnect
Terminal 2:  /link-connect             # reconnects as CLIENT to existing hub
Terminal 2:  /link                     # check name
```

**Expected:**

- Terminal 2 registers requesting "builder" (preferred name, not "builder-2")
- Since "builder" is now free, terminal 2 gets "builder"
- `/link` confirms name is "builder"

---

## 21. Same-name save path

Tests the case where runtime name already matches but preference wasn't saved yet.

**Setup:** One connected terminal.

```
Terminal 1:  pi --link                 # gets random name, e.g. "t-a3f2"
Terminal 1:  /link-name t-a3f2         # same as current name
```

**Expected:**

- Shows "Saved "t-a3f2" as preferred link name"
- Preference is now persisted
- Ctrl+C, `pi --link`, `/resume` → restores "t-a3f2"

---

## 22. Hub session-switch collision guard

Tests that the hub doesn't rename itself into a collision during session switch.

**Setup:** Two terminals. Create the preference BEFORE the conflict exists.

```
Terminal 1:  pi --link                 # hub
Terminal 1:  /link-name alpha          # session A

Terminal 1:  /new                      # session B
Terminal 1:  /link-name beta           # succeeds (no client named beta yet)

Terminal 1:  /resume                   # pick session A ("alpha")
                                       # hub renames in-place to "alpha"

Terminal 2:  pi --link                 # client joins, gets some name
Terminal 2:  /link-name beta           # terminal 2 takes "beta"

Terminal 1:  /resume                   # pick session B (preference "beta")
```

**Expected:**

- Hub warns: `Session preferred name "beta" is taken, keeping "alpha"`
- Hub keeps "alpha" identity
- No rename happens
- Terminal 2 stays connected, sees no leave/join churn

---

## 23. Auto-reconnect to new hub retries preferred name

Tests that when a client auto-reconnects to a new hub (after hub death + another terminal promoting), it requests the preferred name.

**Setup:** Three terminals.

```
Terminal 1:  pi --link                 # hub
Terminal 1:  /link-name builder

Terminal 2:  pi --link                 # client
Terminal 2:  /link-name builder        # gets "builder-2" (conflict)

Terminal 3:  pi --link                 # client

Terminal 1:  Ctrl+C                    # kill hub
                                       # wait 2-5s
                                       # terminal 3 (or 2) promotes to hub
                                       # the other auto-reconnects as CLIENT
```

**If terminal 3 promotes to hub:**

- Terminal 2 auto-reconnects as client, requesting "builder" (preferred name)
- Since "builder" is now free (terminal 1 is gone), terminal 2 gets "builder"
- `/link` on terminal 2 confirms name is "builder"

**If terminal 2 promotes to hub:**

- Terminal 2 becomes hub with runtime name "builder-2" (hub promotion uses current `terminalName`)
- The preferred name fix does NOT apply here — hub promotion doesn't go through `connectAsClient`
- This is a known limitation: hub promotion doesn't retry preferred name

---

## 24. link_send to a specific terminal

**Setup:** Two connected terminals.

```
Terminal 1:  pi --link
Terminal 1:  /link-name alice

Terminal 2:  pi --link
Terminal 2:  /link-name bob
```

**From Terminal 1, ask the LLM:** "Send a message to bob saying hello"

**Expected:**

- LLM uses `link_send` tool with `to: "bob"`, `message: "hello"`
- Terminal 2 sees the message rendered as `⚡ [alice] hello`
- Terminal 1 sees a success indicator (✓) in the tool result

---

## 25. link_send to missing target

**Setup:** Two connected terminals.

```
Terminal 1:  pi --link
Terminal 2:  pi --link
```

**From Terminal 1, ask the LLM:** "Send a message to charlie"

**Expected:**

- LLM uses `link_send` with `to: "charlie"`
- Hub can't find "charlie"
- Terminal 1 sees an error: `Terminal "charlie" not found`

---

## 26. link_send broadcast

**Setup:** Three connected terminals.

```
Terminal 1:  pi --link
Terminal 2:  pi --link
Terminal 3:  pi --link
```

**From Terminal 1, ask the LLM:** "Send a message to everyone saying meeting in 5"

**Expected:**

- LLM uses `link_send` with `to: "*"`
- Terminal 2 and terminal 3 both see `⚡ [<terminal-1-name>] meeting in 5`
- Terminal 1 does NOT see its own broadcast

---

## 27. link_prompt success round-trip

**Setup:** Two connected terminals.

```
Terminal 1:  pi --link
Terminal 1:  /link-name alice

Terminal 2:  pi --link
Terminal 2:  /link-name bob
```

**From Terminal 1, ask the LLM:** "Ask bob what 2+2 is"

**Expected:**

- LLM uses `link_prompt` tool with `to: "bob"`, `prompt: "what is 2+2"`
- Terminal 2 receives the prompt, its LLM processes it, responds
- Terminal 1 gets the response back in the tool result
- Terminal 1 sees ✓ with bob's response text

---

## 28. link_prompt missing target

**Setup:** Two connected terminals.

```
Terminal 1:  pi --link
Terminal 2:  pi --link
```

**From Terminal 1, ask the LLM:** "Ask charlie what time it is"

**Expected:**

- LLM uses `link_prompt` with `to: "charlie"`
- Hub synthesizes an error `prompt_response` (terminal not found)
- Terminal 1 sees ✗ with error message
- No timeout wait — fails fast

---

## 29. link_prompt busy rejection

**Setup:** Two connected terminals.

```
Terminal 1:  pi --link
Terminal 1:  /link-name alice

Terminal 2:  pi --link
Terminal 2:  /link-name bob
```

**Step 1:** Make terminal 2 busy — send it a prompt that takes a while (e.g., "write a long essay about philosophy")

**Step 2:** While terminal 2 is still working, from terminal 1 ask: "Ask bob what 2+2 is"

**Expected:**

- Terminal 2 rejects the prompt request (agent is busy)
- Terminal 1 gets an error response: "Terminal is busy"
- Terminal 1 sees ✗ with the busy message

---

## 30. /link-broadcast command

**Setup:** Three connected terminals.

```
Terminal 1:  pi --link
Terminal 2:  pi --link
Terminal 3:  pi --link
```

```
Terminal 1:  /link-broadcast hello everyone
```

**Expected:**

- Terminal 2 and terminal 3 both see `⚡ [<terminal-1-name>] hello everyone`
- Terminal 1 sees "Broadcast sent" notification
- Terminal 1 does NOT see its own broadcast message
