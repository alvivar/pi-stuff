---
name: clipboard-copy
description: Copy text, code, or a response to the clipboard when the user requests it, on local Windows (Git Bash) or Android/Termux.
---

# Copy to the clipboard

Copy only when asked. Do not read the clipboard or create temporary files.

Run this in `codemode` on either platform. Set `script` to the absolute path of this skill's `scripts/copy.cjs` (forward slashes on Windows). Replace `EXACT_TEXT` with a JSON-escaped string: `\` as `\\`, `"` as `\"`, LF as `\n`, CRLF as `\r\n`.

```js
const value = "EXACT_TEXT";
const script = "ABSOLUTE_PATH_TO_SKILL/scripts/copy.cjs";
const bytes = encodeURIComponent(value).replace(/%([0-9A-F]{2})/g, (_, hex) =>
  String.fromCharCode(parseInt(hex, 16)),
);
const pathArg = "'" + script.replace(/'/g, "'\\''") + "'";
const result = await tools.bash({
  command: `printf '%s' '${btoa(bytes)}' | node ${pathArg}`,
});
if (result.exit_code !== 0) throw new Error(result.output);
text(result.output.trim());
```

Report the script's result. On failure, report the error without trying another route. Do not claim the copy is verified.
