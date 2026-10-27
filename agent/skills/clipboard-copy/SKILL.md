---
name: clipboard-copy
description: Copy text, code, or a response to the clipboard when the user requests it, on local Windows (Git Bash) or Android/Termux.
---

# Copy to the clipboard

Copy only when asked. Do not read the clipboard.

Replace `LITERAL_TEXT` with the exact text inside the shell single quotes, writing each `'` as `'\''`.

## Windows

```bash
printf '%s' 'LITERAL_TEXT' | powershell.exe -NoLogo -NoProfile -NonInteractive -Command '
$ErrorActionPreference = "Stop"
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
$text = [Console]::In.ReadToEnd()
Set-Clipboard -Value $text
'
```

If the text contains backslashes or must keep CRLF line endings, run this `codemode` script instead. Write `EXACT_TEXT` as a JavaScript string literal: `\` as `\\`, `"` as `\"`, LF as `\n`, CRLF as `\r\n`.

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

## Termux

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

## Result

- On failure, report the error. Do not try another route.
- On success, report “Clipboard command completed” (Windows) or “OSC 52 sequence sent” (Termux). Do not claim the copy is verified.
