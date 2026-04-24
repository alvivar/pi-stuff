#!/usr/bin/env node

// pi-link CLI — utilities for pi-link
//
// Subcommands:
//   resolve <name>  Find a Pi session by display name.
//                   Prints session path to stdout (1 match), nothing (0), or
//                   candidates to stderr + exit 1 (ambiguous).

import { readdir, stat } from "fs/promises";
import { createReadStream } from "fs";
import { createInterface } from "readline";
import { join } from "path";
import { homedir } from "os";

const SESSIONS_DIR = join(homedir(), ".pi", "agent", "sessions");

async function getSessionMeta(filePath) {
  let name;
  let cwd;
  const rl = createInterface({ input: createReadStream(filePath, "utf-8"), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === "session" && typeof entry.cwd === "string") cwd = entry.cwd;
      if (entry.type === "session_info" && typeof entry.name === "string") {
        name = entry.name.trim().replace(/\s+/g, " ") || undefined;
      }
    } catch {
      // skip malformed lines
    }
  }
  return { name, cwd };
}

async function findSessionsByName(targetName) {
  let cwdDirs;
  try {
    cwdDirs = await readdir(SESSIONS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }

  const matches = [];

  for (const dir of cwdDirs) {
    if (!dir.isDirectory()) continue;
    const dirPath = join(SESSIONS_DIR, dir.name);

    let files;
    try {
      files = await readdir(dirPath);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const filePath = join(dirPath, file);
      try {
        const { name, cwd } = await getSessionMeta(filePath);
        if (name === targetName) {
          const stats = await stat(filePath);
          matches.push({ path: filePath, cwd: cwd || "?", modified: stats.mtime });
        }
      } catch {
        continue;
      }
    }
  }

  // Local-first: current cwd matches before others, then by modified time
  const localCwd = process.cwd();
  matches.sort((a, b) => {
    const aLocal = a.cwd === localCwd ? 1 : 0;
    const bLocal = b.cwd === localCwd ? 1 : 0;
    if (aLocal !== bLocal) return bLocal - aLocal;
    return b.modified.getTime() - a.modified.getTime();
  });
  return matches;
}

// ── CLI ────────────────────────────────────────────────────────────────────

const [command, ...args] = process.argv.slice(2);

if (command === "resolve") {
  const name = args[0]?.trim().replace(/\s+/g, " ");
  if (!name) {
    console.error("Usage: pi-link resolve <name>");
    process.exit(1);
  }

  const matches = await findSessionsByName(name);

  if (matches.length === 1) {
    process.stdout.write(matches[0].path);
  } else if (matches.length > 1) {
    console.error(`Multiple sessions named "${name}":\n`);
    for (const m of matches) {
      console.error(`  ${m.modified.toISOString().slice(0, 19)}  cwd: ${m.cwd}`);
      console.error(`  ${m.path}\n`);
    }
    console.error(`Use: pi --session <path> --link-name ${name}`);
    process.exit(1);
  }
  // 0 matches: print nothing, exit 0
} else {
  console.error(`Usage: pi-link <command>\n\nCommands:\n  resolve <name>  Find a Pi session by display name`);
  process.exit(command ? 1 : 0);
}
