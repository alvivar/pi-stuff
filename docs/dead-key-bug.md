# Pi Terminal Bug Fixes (reapply after every Pi update)

Two independent fixes for the VSCode integrated terminal. Both live in `pi-tui` and get wiped by every Pi update.

## Fix 1: Dead keys

### Goal

Fix dead key accent composition (`´`+`a`→`á`, `~`+`a`→`ã`, etc.) in VSCode terminal **without breaking Shift+Enter** (new line in editor).

### Quick Fix

File: `C:\Users\andre\AppData\Roaming\npm\node_modules\@mariozechner\pi-coding-agent\node_modules\@mariozechner\pi-tui\dist\terminal.js`

In `setupStdinBuffer()`, find:

```javascript
process.stdout.write("\x1b[>7u");
```

Replace with:

```javascript
const kittyFlags = process.env.TERM_PROGRAM === "vscode" ? 5 : 7;
process.stdout.write(`\x1b[>${kittyFlags}u`);
```

That's it. One line.

## Why

VSCode's xterm.js Kitty protocol is broken for dead keys when flag 2 (event types) is enabled. Flag 2 causes xterm.js to send the dead key as a raw character and the vowel as only a release event (which Pi filters out). Dropping flag 2 (flags 7→5) fixes dead keys while keeping Shift+Enter and all other shortcuts working.

### Do NOT fall back to modifyOtherKeys

An earlier attempt skipped Kitty entirely and used modifyOtherKeys. This broke Shift+Enter (new line in editor). Flags 5 is the correct fix.

## Fix 2: Bare Fn key inserts a stray glyph

### Goal

Stop the laptop `Fn` key (and other unmapped functional keys like CapsLock) from inserting a Unicode Private Use Area glyph into the editor when pressed in VSCode terminal.

### Quick Fix

File: `C:\Users\andre\AppData\Roaming\npm\node_modules\@mariozechner\pi-coding-agent\node_modules\@mariozechner\pi-tui\dist\keys.js`

In `decodeKittyPrintable()` (near the end of the file), find:

```javascript
    effectiveCodepoint = normalizeKittyFunctionalCodepoint(effectiveCodepoint);
    // Drop control characters or invalid codepoints.
    if (!Number.isFinite(effectiveCodepoint) || effectiveCodepoint < 32)
        return undefined;
    try {
        return String.fromCodePoint(effectiveCodepoint);
    }
```

Replace with:

```javascript
    effectiveCodepoint = normalizeKittyFunctionalCodepoint(effectiveCodepoint);
    // Drop control characters or invalid codepoints.
    if (!Number.isFinite(effectiveCodepoint) || effectiveCodepoint < 32)
        return undefined;
    // Drop Unicode Private Use Area codepoints. Kitty protocol assigns PUA
    // codepoints (U+E000..U+F8FF) to functional/modifier keys (e.g. 57441/57442
    // for left/right Fn-style keys, 57358-57363 for CapsLock/NumLock/etc.).
    // VSCode's xterm.js emits these for keys like Fn that Pi doesn't recognize
    // as functional, and without this guard they'd be inserted as stray glyphs.
    if ((effectiveCodepoint >= 0xe000 && effectiveCodepoint <= 0xf8ff) ||
        (effectiveCodepoint >= 0xf0000 && effectiveCodepoint <= 0xffffd) ||
        (effectiveCodepoint >= 0x100000 && effectiveCodepoint <= 0x10fffd))
        return undefined;
    try {
        return String.fromCodePoint(effectiveCodepoint);
    }
```

### Why

When Kitty protocol flag 1 (disambiguate) is on, VSCode's xterm.js wraps key events as CSI-u sequences. Per the Kitty spec, functional/modifier keys use Private Use Area codepoints (e.g. 57441 LeftFn, 57358 CapsLock). `decodeKittyPrintable()` only normalized the numpad/arrow subset (57399-57426); anything else in the PUA flowed straight into `String.fromCodePoint()` and got inserted as a stray glyph. This guard rejects all PUA codepoints, which are never legitimate text input.

### Verification

```bash
cd /c/Users/andre/AppData/Roaming/npm/node_modules/@mariozechner/pi-coding-agent/node_modules/@mariozechner/pi-tui/dist
node -e "import('./keys.js').then(m => { console.log('Fn:', m.decodeKittyPrintable('\x1b[57441u')); console.log('a:', m.decodeKittyPrintable('\x1b[97u')); console.log('é:', m.decodeKittyPrintable('\x1b[233u')); })"
# Expected: Fn: undefined, a: a, é: é
```

Not related to Fix 1 (kittyFlags=5 vs 7) — the PUA insertion happens with both flag values because flag 1 alone triggers the CSI-u wrapping.
