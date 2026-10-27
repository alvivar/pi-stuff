---
name: clipboard-copy
description: Copy text, code, or a response to the clipboard when the user requests it, on local Windows or Android/Termux. Uses PowerShell on Windows and OSC 52 on Termux.
compatibility: Windows bash with powershell.exe and Set-Clipboard, or local PI on Termux with Node.js, /proc, and an OSC 52 terminal. Exact-text encoding on Windows uses codemode with btoa.
---

# Copy to the clipboard

Copy only when requested. This replaces the previous clipboard contents. Do not read the clipboard, including for verification or backup. Do not create temporary files.

Use the actual environment of the `bash` tool, not the working directory: Windows bash uses **Windows** below; local Android/Termux uses **Termux**. Do not route through WSL.

## Pass text safely

For direct input, replace `LITERAL_TEXT` with the exact requested text. Use shell single quotes; represent each apostrophe as `'\''`. Pass text through stdin, never as shell, PowerShell, or Node.js code. Do not use interpolation, `echo`, or command substitution to transport it. `printf '%s'` adds no trailing newline.

## Windows

For ordinary text, run this with `bash`. Explicit UTF-8 decoding preserves accents and emoji; `ReadToEnd()` preserves LF line breaks and trailing newlines.

```bash
printf '%s' 'LITERAL_TEXT' | powershell.exe -NoLogo -NoProfile -NonInteractive -Command '
$ErrorActionPreference = "Stop"
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
$text = [Console]::In.ReadToEnd()
Set-Clipboard -Value $text
'
```

### Exact text: backslashes or CRLF

The Windows tool/shell transport can collapse repeated backslashes and normalize CRLF inside command literals. When the requested text contains backslashes or requires exact CRLF, encode it as UTF-8 Base64 **before** passing it to `bash`. Encoding after `printf` would be too late.

In `codemode`, use a correctly JSON-escaped string literal for `value` (backslashes as `\\`, CRLF as `\r\n`). This computes Base64 in memory without files or another installed encoder:

```js
const value = "EXACT_TEXT";
const bytes = encodeURIComponent(value).replace(/%([0-9A-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
text(btoa(bytes));
```

Use the resulting Base64 as `BASE64_UTF8` below. Do not manually guess the encoding. If `codemode` or its encoder is unavailable, report that limitation rather than creating a file or sending potentially altered text.

```bash
printf '%s' 'BASE64_UTF8' | powershell.exe -NoLogo -NoProfile -NonInteractive -Command '
$ErrorActionPreference = "Stop"
$encoded = [Console]::In.ReadToEnd()
$text = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded))
Set-Clipboard -Value $text
'
```

## Termux

Use OSC 52 for local PI on Termux. It requires the process chain Node → bash tool shell → PI, with PI stdout pointing to `/dev/pts/`. Normal tool output is captured, so the sequence must go directly to the PI terminal.

```bash
printf '%s' 'LITERAL_TEXT' | node -e '
const fs = require("node:fs");

const text = fs.readFileSync(0, "utf8");
const shellStatus = fs.readFileSync(`/proc/${process.ppid}/status`, "utf8");
const piPid = shellStatus.match(/^PPid:\s+(\d+)/m)[1];
const target = `/proc/${piPid}/fd/1`;
const terminal = fs.readlinkSync(target);

if (!terminal.startsWith("/dev/pts/")) {
  throw new Error(`PI output is not a terminal: ${terminal}`);
}

const encoded = Buffer.from(text, "utf8").toString("base64");
fs.writeFileSync(target, `\x1b]52;c;${encoded}\x07`);
console.log("OSC 52 sequence sent to the terminal.");
'
```

## Results and failures

- Check the exit status. Report failures; do not silently retry other routes, install dependencies, or change system configuration.
- After a successful Windows command, report “Clipboard command completed”. Do not claim an independently verified copy.
- After successful Termux output, report “OSC 52 sequence sent”. OSC 52 does not confirm that the terminal updated the clipboard.
- If verification is needed, ask the user to paste into another app. Do not request this after every copy or read the clipboard yourself.
- Do not assume the Termux process chain works over SSH/tmux or that either route handles arbitrary text sizes. Report the concrete limitation instead of adding speculative support.
