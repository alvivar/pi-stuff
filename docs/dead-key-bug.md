# Dead Key Bug Fix (reapply after every Pi update)

## Goal

Fix dead key accent composition (`´`+`a`→`á`, `~`+`a`→`ã`, etc.) in VSCode terminal **without breaking Shift+Enter** (new line in editor).

## Quick Fix

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

## Do NOT fall back to modifyOtherKeys

An earlier attempt skipped Kitty entirely and used modifyOtherKeys. This broke Shift+Enter (new line in editor). Flags 5 is the correct fix.
