// node observe.mjs <agent> <marker>
// pi-dock README "Observer" recipe; runs pi-dock's bin with Node because pi-dock is not on PATH.
// Exits 0 and prints the final text once a `text` event's last line is the marker.
import { execFileSync } from 'node:child_process';

const PI_DOCK = 'C:/Users/andre/.pi/agent/npm/node_modules/pi-dock/bin/pi-dock.mjs';

const [agent, marker] = process.argv.slice(2);
if (!/^[a-z0-9._-]+$/.test(agent ?? '') || !marker) {
  throw new Error('usage: node observe.mjs <agent> <marker>');
}
const read = () => execFileSync(process.execPath, [PI_DOCK, 'logs', agent, '--raw'],
  { encoding: 'utf8', maxBuffer: Infinity })
  .split('\n').filter(Boolean).map((line) => JSON.parse(line));

for (;;) {
  const events = read();
  const final = events.find((event) => event.event === 'text'
    && event.text.trimEnd().split(/\r?\n/).at(-1).trim() === marker);
  if (final) {
    console.log(final.text);
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 15_000));
}
