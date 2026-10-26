// node setup.mjs <s1..s10|r> [v] : creates run folder, roster, prompts under %TEMP%/pi-link-lab; prints run id
// The prompts are the code blocks of the scenario's section in SCENARIOS.md, in order.
// With `v`, the boot prompt is "Boot prompt V" (no forced read) and the run id starts with `v-`.
import fs from 'node:fs';

const [sc, variant] = process.argv.slice(2);
const G = `${variant === 'v' ? 'v-' : ''}${sc}-${Date.now().toString(36).slice(-6)}`;
const t = fs.readFileSync('C:/Users/andre/.pi/agent/workshop/pi-link/lab/SCENARIOS.md', 'utf8').replace(/\r/g, '');
const codeBlocks = (text) => [...text.matchAll(/```\n([\s\S]*?)\n```/g)].map((m) => m[1]);
const sectionOf = (heading) => t.split(`\n## ${heading}`)[1].split('\n## ')[0];
// PI_LINK_LAB_SKILL points the forced read at another copy of the skill (isolated agent dir runs).
const INSTALLED_SKILL = 'C:/Users/andre/.pi/agent/npm/node_modules/pi-link/skills/pi-link-tools/SKILL.md';
const boot = codeBlocks(sectionOf(variant === 'v' ? 'Boot prompt V' : 'Boot prompt (all roles)'))[0]
  .replace(INSTALLED_SKILL, process.env.PI_LINK_LAB_SKILL ?? INSTALLED_SKILL);

const later = 'llegará después de esta comprobación.';
const sol = `Necesitarás datos que tienen otros miembros del grupo. El encargo ${later}`;
const cons = `Custodias un catálogo que los demás miembros pueden consultarte. Los datos llegarán después de esta comprobación.`;
const cot = `Custodias cotizaciones que los demás miembros pueden consultarte. Los datos llegarán después de esta comprobación.`;
const datos = `Custodias datos que los demás miembros pueden consultarte. Los datos llegarán después de esta comprobación.`;
const inv = `Custodias un inventario que los demás miembros pueden consultarte. Los datos llegarán después de esta comprobación.`;
const cfg = {
  s1: { desc: { solicitante: sol, especialista: cons }, blocks: ['prep-especialista', 'mission-solicitante'] },
  s2: { desc: { coordinador: `Coordinas una compra con datos que tienen otros miembros del grupo. El encargo ${later}`, north: cot, south: cot }, blocks: ['prep-north', 'prep-south', 'mission-coordinador'] },
  s3: { desc: { solicitante: sol, especialista: cons }, blocks: ['prep-especialista', 'mission-solicitante'] },
  s4: { desc: { coordinador: `Gestionas el contexto de otros miembros del grupo. El encargo ${later}`, trabajador: `Ejecutas trabajos que se te asignan. El trabajo ${later}` }, blocks: ['prep-trabajador-historial', 'prep-trabajador', 'mission-coordinador'] },
  s5: { desc: { emisor: sol, receptor: datos }, blocks: ['prep-receptor', 'mission-emisor'] },
  s6: { desc: { solicitante: sol, especialista: cons }, blocks: ['prep-especialista', 'mission-solicitante', 'status-solicitante'] },
  s7: { desc: { solicitante: sol, especialista: cons }, blocks: ['prep-especialista', 'mission-solicitante'] },
  s8: { desc: { 'solicitante-a': sol, 'solicitante-b': sol, especialista: cons }, blocks: ['prep-especialista', 'mission-solicitante-a', 'mission-solicitante-b'] },
  s9: { desc: { solicitante: sol, especialista: cons }, blocks: ['prep-especialista', 'mission-solicitante', 'status-solicitante'] },
  s10: { desc: { coordinador: `Coordinas un recuento con datos que tienen otros miembros del grupo. El encargo ${later}`, alfa: inv, beta: inv, gamma: inv }, blocks: ['prep-alfa', 'prep-beta', 'prep-gamma', 'mission-coordinador'] },
  r: { desc: { emisor: `Enviarás mensajes a otros miembros del grupo. El encargo ${later}`, receptor: `Atiendes mensajes de otros miembros del grupo. Las instrucciones ${later.replace('llegará', 'llegarán')}` }, blocks: ['prep-receptor', 'mission-emisor'] },
}[sc];
if (!cfg) throw new Error('usage: node setup.mjs <s1..s10|r> [v]');

const run = `${process.env.TEMP}/pi-link-lab/${G}`;
fs.mkdirSync(`${run}/prompts`, { recursive: true });
for (const role in cfg.desc) {
  fs.mkdirSync(`${run}/${role}`);
  const compact = sc === 's4' && role === 'coordinador' ? '' : ', no compactes sesiones';
  fs.writeFileSync(`${run}/prompts/boot-${role}.txt`, boot.replaceAll('{G}', G).replace('{ROL}', role)
    .replace('{DESC}', cfg.desc[role]).replace('{COMPACT}', compact));
}
const blocks = codeBlocks(sectionOf(`${sc.toUpperCase()} `));
if (blocks.length !== cfg.blocks.length) throw new Error(`expected ${cfg.blocks.length} blocks, got ${blocks.length}`);
cfg.blocks.forEach((name, i) => fs.writeFileSync(`${run}/prompts/${name}.txt`, blocks[i].replaceAll('{G}', G)));
fs.writeFileSync(`${run}/roster.txt`, Object.keys(cfg.desc).map((role) => `${G}-${role}`).join('\n') + '\n');
fs.writeFileSync(`${process.env.TEMP}/pi-link-lab/current`, G + '\n');
console.log(G);
