// node summary.mjs <pi-dock name>... : compact post-boot timeline per agent (for comparing many runs)
// Skips the boot turn, tool results except errors and failed sends, and truncates long text.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PI_DOCK = 'C:/Users/andre/.pi/agent/npm/node_modules/pi-dock/bin/pi-dock.mjs';
const SKILL = 'pi-link-tools/SKILL.md';
const cut = (text, n) => text.replace(/\s+/g, ' ').trim().slice(0, n);
const textOf = (content) => typeof content === 'string'
  ? content : content.filter((part) => part.type === 'text').map((part) => part.text).join('');

for (const name of process.argv.slice(2)) {
  const show = execFileSync(process.execPath, [PI_DOCK, 'show', name], { encoding: 'utf8' });
  const file = show.match(/^session\s+(.+)$/m)[1].trim();
  const lines = [];
  let users = 0;
  for (const line of readFileSync(file, 'utf8').trim().split('\n')) {
    const entry = JSON.parse(line);
    const at = entry.timestamp?.slice(11, 19);
    if (entry.type === 'custom_message') {
      const body = textOf(entry.content);
      const senders = [...body.matchAll(/^From "([^"]+)":/gm)].map((m) => m[1].split('@')[0]);
      const outcomes = body.match(/^link_compact .*$/gm) ?? [];
      lines.push(`${at} LINK from=[${senders.join(',')}]${outcomes.length ? ` outcomes=${outcomes.length}` : ''} ${cut(body.replace(/^\[Link: \d+ message\(s\) received\]/, ''), 100)}`);
      continue;
    }
    if (entry.type === 'compaction') lines.push(`${at} COMPACTION tokensBefore=${entry.tokensBefore}`);
    if (entry.type !== 'message') continue;
    const message = entry.message;
    if (message.role === 'user') { users += 1; if (users > 1) lines.push(`${at} USER ${cut(textOf(message.content), 60)}`); continue; }
    if (users < 2 && !(message.role === 'assistant' && message.content.some((c) => c.type === 'toolCall' && c.name === 'read' && !c.arguments.path.includes(SKILL)))) continue;
    if (message.role === 'assistant') {
      for (const part of message.content) {
        if (part.type === 'toolCall') {
          const args = part.arguments;
          const shown = part.name === 'link_send' ? `to=${args.to} ${cut(args.message, 70)}`
            : part.name === 'read' ? args.path : part.name === 'bash' ? cut(args.command, 70) : cut(JSON.stringify(args), 70);
          if (part.name !== 'read' || !args.path.includes(SKILL)) lines.push(`${at} ${part.name} ${shown}`);
        }
        if (part.type === 'text' && part.text.trim() && users > 1) lines.push(`${at} TEXT ${cut(part.text, 110)}`);
      }
    }
    if (message.role === 'toolResult' && (message.isError || (message.toolName === 'link_send' && !/^Sent to hub/.test(textOf(message.content))))) {
      lines.push(`${at} ERROR ${message.toolName} ${cut(textOf(message.content), 90)}`);
    }
  }
  console.log(`## ${name}\n${lines.join('\n')}`);
}
