# Pi Fn Key Glyph Fix (reapply after every Pi update)

This is the only remaining VSCode terminal keyboard fix: pressing bare `Fn`/similar unmapped functional keys inserts a weird Unicode Private Use Area glyph into the editor.

## Goal

Stop Kitty CSI-u Private Use Area functional-key codepoints from being decoded as printable editor text.

This fix is independent of dead keys, Shift+Enter, and Kitty flag `5`/`7` behavior. Do not change `terminal.js` for this issue.

## Quick Fix

File:

```text
C:\Users\andre\AppData\Roaming\npm\node_modules\@earendil-works\pi-coding-agent\node_modules\@earendil-works\pi-tui\dist\keys.js
```

In `decodeKittyPrintable()`, find:

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

## Why

VSCode/xterm.js can emit bare `Fn` and other unmapped functional keys as Kitty CSI-u sequences using Unicode Private Use Area codepoints, for example:

- `\x1b[57441u` → Left Fn → `U+E061`
- `\x1b[57442u` → Right Fn → `U+E062`
- `\x1b[57358u` → CapsLock-style key → `U+E00E`

`decodeKittyPrintable()` currently accepts those because they are finite codepoints above `32`, then calls `String.fromCodePoint()`, which inserts the weird glyph.

Private Use Area codepoints are not legitimate text input here, so the printable decoder should reject them.

## Verification

```bash
node --input-type=module -e "import { decodeKittyPrintable } from 'file:///C:/Users/andre/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/keys.js'; console.log('Fn:', decodeKittyPrintable('\x1b[57441u')); console.log('RightFn:', decodeKittyPrintable('\x1b[57442u')); console.log('CapsLock:', decodeKittyPrintable('\x1b[57358u')); console.log('a:', decodeKittyPrintable('\x1b[97u')); console.log('é:', decodeKittyPrintable('\x1b[233u'));"
```

Expected:

```text
Fn: undefined
RightFn: undefined
CapsLock: undefined
a: a
é: é
```
