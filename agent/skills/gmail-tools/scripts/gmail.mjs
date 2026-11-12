#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { GmailService, COMMANDS, outputText } from './service.mjs';
import { withState } from './store.mjs';

export const HELP = `Gmail skill CLI (local browser-use, no Pi extension)
Usage: node <skill>/scripts/gmail.mjs COMMAND [--session NAME] [--confirm DIGEST]
Read one JSON parameter object from stdin. Emit one JSON result to stdout.
Commands: connect, scan, inspect, prepare, apply, verify, batch
PI_SESSION_ID selects session-local state by default; outside Pi use --session.
Only apply accepts --confirm. Obtain user authorization before passing it.
Example:
  node <skill>/scripts/gmail.mjs scan <<'JSON'
  {"query":"in:inbox","limit":50}
  JSON
No command sends mail, permanently deletes mail, or changes external accounts.
`;
export function parseArgs(args, env = process.env) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return { help: true };
  const [command, ...rest] = args;
  if (!COMMANDS.includes(command)) throw new Error('Unknown command. Use --help.');
  let session = env.PI_SESSION_ID, confirmation;
  const seen = new Set();
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i], value = rest[i + 1];
    if (!['--session', '--confirm'].includes(flag) || value === undefined || value.startsWith('--') || seen.has(flag)) throw new Error('Invalid/duplicate option.');
    seen.add(flag);
    if (flag === '--session') session = value;
    else confirmation = value;
  }
  if (confirmation !== undefined && command !== 'apply') throw new Error('--confirm is only valid for apply.');
  if (confirmation !== undefined && !/^[a-f0-9]{64}$/.test(confirmation)) throw new Error('Invalid confirmation digest.');
  return { command, session, confirmation };
}
export async function stdinObject(input) {
  const chunks = [];
  let size = 0;
  for await (const chunk of input) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error('Input exceeds 1MB.');
    chunks.push(chunk);
  }
  // Decode once: a UTF-8 sequence can be split across chunks.
  const value = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(value); } catch { throw new Error('Supply one valid JSON object on stdin.'); }
}
export async function main(args = process.argv.slice(2), env = process.env, input = process.stdin) {
  const options = parseArgs(args, env);
  if (options.help) { process.stdout.write(HELP); return; }
  const params = await stdinObject(input);
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.on('SIGINT', abort); process.on('SIGTERM', abort);
  try {
    const result = await withState(options.session, (state, save) =>
      new GmailService({ state, save }).run(options.command, params, { confirmation: options.confirmation, signal: controller.signal }));
    process.stdout.write(outputText(result));
    if (result.ok === false) process.exitCode = 1;
  } finally {
    process.off('SIGINT', abort); process.off('SIGTERM', abort);
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    process.stdout.write(outputText({ ok: false, error: error.code ?? 'gmail_cli_error',
      message: String(error.message).slice(0, 800), ...(error.report ? { report: error.report } : {}) }));
    process.exitCode = 1;
  });
}
