const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

try {
  const encoded = fs.readFileSync(0, "utf8");
  const bytes = Buffer.from(encoded, "base64");
  // Buffer.from silently ignores malformed Base64.
  if (bytes.toString("base64") !== encoded) {
    throw new Error("Invalid Base64 input");
  }

  if (process.platform === "win32") {
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoLogo", "-NoProfile", "-NonInteractive",
        "-Command", `
$ErrorActionPreference = "Stop"
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
$text = [Console]::In.ReadToEnd()
Set-Clipboard -Value $text
`,
      ],
      { input: bytes, encoding: "utf8", shell: false },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(
        result.stderr.trim() || result.stdout.trim() ||
        `PowerShell failed: ${result.signal || result.status}`,
      );
    }
    console.log("Clipboard command completed");
  } else if (
    process.platform === "android" ||
    process.env.TERMUX_VERSION ||
    process.env.PREFIX?.startsWith("/data/data/com.termux/")
  ) {
    const shellStatus = fs.readFileSync(`/proc/${process.ppid}/status`, "utf8");
    const piPid = shellStatus.match(/^PPid:\s+(\d+)/m)[1];
    const target = `/proc/${piPid}/fd/1`;
    const terminal = fs.readlinkSync(target);
    if (!terminal.startsWith("/dev/pts/")) {
      throw new Error(`PI output is not a terminal: ${terminal}`);
    }
    fs.writeFileSync(target, `\x1b]52;c;${encoded}\x07`);
    console.log("OSC 52 sequence sent");
  } else {
    throw new Error("Only Windows and local Termux are supported");
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
