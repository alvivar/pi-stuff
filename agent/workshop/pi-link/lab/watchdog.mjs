// node watchdog.mjs <ISO deadline> <roster file>
// pi-dock README "Watchdog" recipe; runs pi-dock's bin with Node because pi-dock is not on PATH.
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

const PI_DOCK = 'C:/Users/andre/.pi/agent/npm/node_modules/pi-dock/bin/pi-dock.mjs';

const [deadlineText, rosterFile] = process.argv.slice(2);
const deadline = Date.parse(deadlineText);
const roster = readFileSync(rosterFile, 'utf8').split(/\s+/).filter(Boolean);
const badName = roster.find((name) => !/^[a-z0-9._-]+$/.test(name));
if (Number.isNaN(deadline) || roster.length === 0 || badName !== undefined) {
  throw new Error('usage: node watchdog.mjs <ISO deadline> <roster file of agent names>');
}
const record = (text) => appendFileSync('watchdog.log', `${new Date().toISOString()} ${text}\n`);
record(`armed until ${new Date(deadline).toISOString()} for ${roster.join(' ')}`);

while (Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, Math.min(60_000, deadline - Date.now())));
}
let failed = false;
for (const name of roster) {
  const stop = spawnSync(process.execPath, [PI_DOCK, 'stop', name], { encoding: 'utf8' });
  const output = stop.error?.message ?? `${stop.stdout}${stop.stderr}`.trim();
  record(`${name}: exit ${stop.status}: ${output}`);
  failed ||= stop.status !== 0;
}
process.exitCode = failed ? 1 : 0;
