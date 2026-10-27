---
name: clipboard-copy
description: Copy text, code, or a response to the clipboard when the user requests it, on local Windows or Android/Termux. Uses PowerShell on Windows and OSC 52 on Termux.
compatibility: Windows bash with powershell.exe and Set-Clipboard, or local PI on Termux with Node.js, /proc, and an OSC 52 terminal.
---

# Copy to the clipboard

Copy only when requested. This replaces the previous clipboard contents. Do not read the clipboard, including for verification or backup. Do not create temporary files.

Windows bash uses **Windows** below; local Android/Termux uses **Termux**.

## Pass text safely

For direct input, replace `LITERAL_TEXT` with the exact requested text. Use shell single quotes; represent each apostrophe as `'\''`. Pass text through stdin, never as shell, PowerShell, or Node.js code. Do not use interpolation, `echo`, or command substitution to transport it.

## Windows

For ordinary text, run this with `bash`.

```bash
printf '%s' 'LITERAL_TEXT' | powershell.exe -NoLogo -NoProfile -NonInteractive -Command '
$ErrorActionPreference = "Stop"
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
$text = [Console]::In.ReadToEnd()
Set-Clipboard -Value $text
'
```

### Exact text: backslashes or CRLF

Use this route instead when the text contains backslashes, or when it must keep CRLF line endings because the user asks for CRLF or the source text has them.

Run this as one `codemode` script, so the Base64 is never copied by hand. Replace `EXACT_TEXT` with the text as a JavaScript string literal: write `\` as `\\`, `"` as `\"`, LF as `\n`, and CRLF as `\r\n`.

```js
const value = "EXACT_TEXT";
const bytes = encodeURIComponent(value).replace(/%([0-9A-F]{2})/g, (_, hex) =>
  String.fromCharCode(parseInt(hex, 16)),
);
const result = await tools.bash({
  command: `printf '%s' '${btoa(bytes)}' | powershell.exe -NoLogo -NoProfile -NonInteractive -Command '
$ErrorActionPreference = "Stop"
$encoded = [Console]::In.ReadToEnd()
$text = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded))
Set-Clipboard -Value $text
'`,
});
if (result.exit_code !== 0) throw new Error(result.output);
```

If `codemode` is unavailable, report that limitation rather than creating a file or sending potentially altered text.

## Termux

Use OSC 52 for local PI on Termux.

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
