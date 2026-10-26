// node inspect.mjs <pi-dock name>... : timeline of user/link messages, tool calls and assistant text
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const D = 'C:/Users/andre/.pi/agent/npm/node_modules/pi-dock/bin/pi-dock.mjs';
for (const name of process.argv.slice(2)) {
  const show = execFileSync(process.execPath, [D, 'show', name], { encoding: 'utf8' });
  const file = show.match(/^session\s+(.+)$/m)[1].trim();
  console.log(`\n##### ${name}`);
  for (const line of readFileSync(file, 'utf8').trim().split('\n')) {
    const e = JSON.parse(line);
    if (e.type === 'custom_message') { console.log(e.timestamp.slice(11, 19), 'LINK', JSON.stringify(e.content).replace(/\n/g, ' | ').slice(0, 400)); continue; }
    if (e.type !== 'message') continue;
    const m = e.message, t = e.timestamp.slice(11, 19);
    const txt = (c) => typeof c === 'string' ? c : c.filter((x) => x.type === 'text').map((x) => x.text).join('');
    if (m.role === 'user') console.log(t, 'USER', txt(m.content).slice(0, 80).replace(/\n/g, ' '));
    else if (m.role === 'custom') console.log(t, 'CUSTOM', m.customType, txt(m.content).replace(/\n/g, ' | ').slice(0, 400));
    else if (m.role === 'assistant') for (const c of m.content) {
      if (c.type === 'toolCall') console.log(t, 'CALL', c.name, JSON.stringify(c.arguments).slice(0, 300));
      if (c.type === 'text' && c.text.trim()) console.log(t, 'TEXT', c.text.replace(/\n/g, ' | ').slice(0, 300));
    }
    else if (m.role === 'toolResult') console.log(t, 'RESULT', m.toolName, txt(m.content).replace(/\n/g, ' | ').slice(0, 160));
  }
}
