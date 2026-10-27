---
name: clipboard-copy
description: Copy text, code, or a response to the clipboard when the user requests it. Supports Windows, WSL (Windows clipboard), Linux desktops (Wayland/X11), and Android via local Termux (OSC 52).
compatibility: Requires bash and a backend for the actual environment. Windows/WSL uses powershell.exe with Set-Clipboard; Linux uses wl-copy or xclip and a graphical session; Termux uses Node.js, /proc, and an OSC 52 terminal.
---

# Copy to the clipboard

Copy only when the user requests it. This operation replaces the previous clipboard contents. Do not read the clipboard, including for verification or backup.

## Choose the backend first

Check the actual environment with `uname -s` and the variables below; do not infer it from the working directory. This prevents trying Linux `/proc` paths from Windows Node.js.

- **Windows bash (Git Bash/MSYS/Cygwin):** `uname -s` starts with `MINGW`, `MSYS`, or `CYGWIN`. Check `command -v powershell.exe`, then use **Windows / WSL**.
- **WSL:** on Linux, a nonempty `WSL_DISTRO_NAME` or `microsoft` in `/proc/sys/kernel/osrelease` identifies WSL. Check `command -v powershell.exe`. Use **Windows / WSL** to copy to the Windows host clipboard, even if WSLg exposes `WAYLAND_DISPLAY` and `DISPLAY`. If the user specifically wants a Linux graphical-session clipboard instead, use **Linux desktop**.
- **Android / Termux:** check `TERMUX_VERSION` or a `PREFIX` under `/data/data/com.termux/`. Use **Termux** only with Linux Node.js, `/proc`, and the required terminal/process chain.
- **Other Linux desktops:** check `WAYLAND_DISPLAY`, `DISPLAY`, and `command -v wl-copy` / `command -v xclip`. Use **Linux desktop**.

A missing backend is a preflight failure: report what is missing; do not install dependencies or silently switch clipboard targets. WSL requires working Windows executable interop. A headless Linux shell does not imply access to a desktop clipboard. Over SSH, establish whose clipboard is intended before writing; a remote desktop clipboard is not necessarily the user's local clipboard.

## Pass text safely

Use the `bash` tool for the commands below. Replace `LITERAL_TEXT` with the exact requested text. Use shell single quotes; represent each apostrophe in the text as `'\''`. Pass text through stdin, never as executable code. Do not use interpolation, `echo`, or command substitution to transport it. `printf '%s'` adds no trailing newline and preserves LF line breaks.

For an existing UTF-8 file, exact CRLF line endings, or text containing backslashes on Windows, use input redirection instead of a shell literal: remove `printf '%s' 'LITERAL_TEXT' | ` and append ` < '/path/to/file'` to the backend command below. Git Bash can normalize CRLF inside command literals, and the Windows tool/shell command transport can collapse repeated backslashes. File redirection avoids both transformations. If necessary, create a uniquely named temporary UTF-8 file with the `write` tool, redirect it, and delete it afterward, including on failure. Do not overwrite an existing file or leave a sensitive payload on disk. Use forward slashes in Windows file paths; inside WSL, use the file's Linux path.

## Windows / WSL

Use the same command from Windows bash or directly inside WSL. PowerShell's native `Set-Clipboard` targets the Windows clipboard. Explicit UTF-8 decoding avoids code-page corruption of accents and emoji; `ReadToEnd()` preserves multiline text and trailing newlines. Prefer this over piping UTF-8 directly into `clip.exe`, whose decoding can depend on the input encoding.

```bash
printf '%s' 'LITERAL_TEXT' | powershell.exe -NoLogo -NoProfile -NonInteractive -Command '
$ErrorActionPreference = "Stop"
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
$text = [Console]::In.ReadToEnd()
Set-Clipboard -Value $text
'
```

Do not use `-Append`. If `powershell.exe` is unavailable or interop fails, report the problem rather than trying the Termux `/proc` method. When testing this backend without permission to replace clipboard contents, add `-WhatIf` to `Set-Clipboard`; a dry run is not a copy.

## Linux desktop

Use an installed tool for the intended graphical session; these commands do not require Node.js. Prefer `wl-copy` for Wayland. Use `xclip` for an X11 session when `DISPLAY` is set. In a mixed session, choose before writing, not as a silent retry after a failure.

Wayland (`WAYLAND_DISPLAY` and `wl-copy` required):

```bash
printf '%s' 'LITERAL_TEXT' | wl-copy --type 'text/plain;charset=utf-8'
```

X11 (`DISPLAY` and `xclip` required):

```bash
printf '%s' 'LITERAL_TEXT' | xclip -selection clipboard -in
```

Select the regular clipboard, not the primary selection. Do not add newline-trimming options. The tool may keep a background process to serve clipboard contents; do not kill it just because the command returns. If the display is inaccessible or the tool is missing, report that limitation. Do not automatically fall back to OSC 52 on an untested terminal.

## Termux

This OSC 52 procedure is specific to local PI on Termux. It depends on the process chain Node → bash tool shell → PI and PI stdout pointing to `/dev/pts/`. Do not assume this chain holds in other harnesses, SSH, or tmux; investigate a mismatch instead of guessing another file descriptor.

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

It writes directly to the PI terminal because normal tool output is captured and does not forward OSC 52 sequences to the terminal.

## Result and limitations

- Check the command's exit status. If it fails, report the error. Do not hide failures or automatically try alternative paths/backends.
- After a successful native clipboard command, report “Clipboard command completed”. This is not an independent check of clipboard contents.
- After successful OSC 52 output, report “OSC 52 sequence sent”. OSC 52 does not confirm that the terminal updated the clipboard; never claim a verified copy.
- After `-WhatIf`, report only that the dry run completed; do not claim a copy occurred.
- If verification is needed, ask the user to paste into another app. Do not request this after every copy, and do not read the clipboard yourself.
- Do not assume support for arbitrary text sizes, other platforms, or terminal multiplexers. Investigate the specific failure before extending support.
