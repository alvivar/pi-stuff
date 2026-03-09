# Dead Key / Accent Composition Bug in Pi (VSCode Terminal)

## Problem

Dead key composition (e.g., `´` + `a` → `á`) does not work when running Pi inside VSCode's integrated terminal. Accented characters like `á é í ó ú` cannot be typed. Instead, only the dead key character `´` appears and the vowel is silently dropped.

This affects users with keyboard layouts that rely on dead keys for accented characters (e.g., ABNT2/Portuguese, Spanish, French, German).

## Steps to Reproduce

1. Use a keyboard layout with dead keys for accented characters (e.g., ABNT2/Portuguese, Spanish, French, German)
2. Open **VSCode's integrated terminal**
3. Start Pi: `pi`
4. In the editor input, press the dead key `´` followed by a vowel (e.g., `a`) to compose `á`

**Actual behavior:** The literal dead key character `´` is inserted. The vowel is silently dropped. No composed character appears. The editor shows `´` instead of `á`.

**Expected behavior:** The dead key `´` followed by `a` should produce the composed character `á` in the editor, as it does in any other terminal application and in standalone terminals (Windows Terminal, etc.).

### Additional notes

- The bug affects **all dead key compositions**: `´`+vowel (`á é í ó ú`), `~`+letter (`ã õ ñ`), `^`+letter (`â ê î ô û`), `` ` ``+letter (`à è ì ò ù`), `¨`+letter (`ä ë ï ö ü`)
- The bug does **not** occur in standalone terminals (Windows Terminal, PowerShell, cmd.exe) — only in VSCode's integrated terminal
- The bug does **not** occur if Kitty keyboard protocol is disabled (e.g., using `modifyOtherKeys` fallback)

## Root Cause

VSCode's terminal uses **xterm.js**, which has a broken **Kitty keyboard protocol** implementation for dead key composition.

### The chain of events

1. **Pi starts** and queries for Kitty protocol support: `\x1b[?u`
2. **xterm.js responds** with `\x1b[?0u` — "I support Kitty protocol!"
3. **Pi enables** Kitty flags 7 (`\x1b[>7u`): disambiguate (1) + event types (2) + alternate keys (4)
4. **User presses dead key `´`** → xterm.js sends it as a **raw character** (U+00B4) instead of holding it for composition → Pi inserts literal `´`
5. **User presses vowel `a`** → xterm.js sends **only a key RELEASE** event (`\x1b[97;1:3u`, codepoint 97 = `a`, event type 3 = release) — no press event is emitted, and the composed character `á` is never sent
6. **Pi filters out** all key release events in `tui.js` (`isKeyRelease` check) → the vowel is silently dropped
7. **Result:** only the literal `´` appears in the editor, accent composition is completely broken

### Evidence from input debug log

```
# Dead key ´ arrives as raw character (NOT as CSI-u sequence) — inserted literally
raw-stdin: "´" bytes=[0xc2,0xb4]
insert-char: "´"

# Vowel key releases arrive as CSI-u with event type 3 — all filtered out
raw-stdin: "\x1b[97;1:3u"    → 'a' RELEASE → FILTERED
raw-stdin: "\x1b[101;1:3u"   → 'e' RELEASE → FILTERED
raw-stdin: "\x1b[111;1:3u"   → 'o' RELEASE → FILTERED
raw-stdin: "\x1b[117;1:3u"   → 'u' RELEASE → FILTERED
raw-stdin: "\x1b[105;1:3u"   → 'i' RELEASE → FILTERED
```

The xterm.js bugs are:

- Dead key is sent as a raw byte instead of being held for composition
- The composed character's **press** event is never emitted
- Only the base letter's **release** event is sent (useless — wrong codepoint and wrong event type)

## Fix

In `terminal.js` → `queryAndEnableKittyProtocol()`, detect VSCode's terminal and skip Kitty protocol entirely, falling back to `modifyOtherKeys` mode 2 which handles dead key composition correctly:

```javascript
queryAndEnableKittyProtocol() {
    this.setupStdinBuffer();
    process.stdin.on("data", this.stdinDataHandler);

    // Skip Kitty protocol in VSCode's terminal (xterm.js) — its Kitty
    // implementation is broken for dead key / IME composition: the dead key
    // character is sent as a raw byte instead of being held for composition,
    // the composed character's press event is never emitted, and only a
    // release event for the base letter arrives (which Pi filters out).
    // Fall back to modifyOtherKeys which handles dead keys correctly.
    const isVSCode = process.env.TERM_PROGRAM === "vscode";
    if (isVSCode) {
        process.stdout.write("\x1b[>4;2m");
        this._modifyOtherKeysActive = true;
        return;
    }

    process.stdout.write("\x1b[?u");
    setTimeout(() => {
        if (!this._kittyProtocolActive && !this._modifyOtherKeysActive) {
            process.stdout.write("\x1b[>4;2m");
            this._modifyOtherKeysActive = true;
        }
    }, 150);
}
```

Detection uses `process.env.TERM_PROGRAM === "vscode"`, which VSCode sets in all its integrated terminals.

## Files Modified

- `@mariozechner/pi-tui/dist/terminal.js` — added VSCode detection to skip Kitty protocol

## Notes

- This is a **workaround for an xterm.js bug**, not a Pi bug per se
- The `modifyOtherKeys` fallback provides good key handling — Shift+Enter, modified keys, etc. still work
- If xterm.js fixes their Kitty protocol dead key handling in the future, this check could be revisited or narrowed to specific xterm.js versions
- The fix was applied directly to `node_modules`; it will be lost on `npm install` / `npm update` until upstreamed to Pi's source

## Diagnosis Process

The bug was found by adding input logging (`PI_INPUT_LOG=1`) at four stages of Pi's input pipeline:

1. `raw-stdin` — raw data from `process.stdin`
2. `stdinbuf-out` — after `StdinBuffer` sequence parsing
3. `tui-input` → `dispatch-to-component` — TUI routing with key release filtering
4. `editor-input` → `insert-char` — final character insertion

This revealed that composed characters never arrived as press events, and the release events were being correctly filtered by Pi's key release filter (which exists to prevent double-processing of key events when Kitty flag 2 is active).

## Date

March 8–9, 2026
