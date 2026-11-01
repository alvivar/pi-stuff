// P4 — audit a closing report the logs do not support (diagnostic: no live agents). The solver
// gets copies of pi-dock event logs, the team's artifact and its spec, and six claims from the
// previous operator. Each claim is wrong or undecidable in a way the skill explains. The rubric
// below is for the human/agent review of answer.md; the solver must not see it.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { evalRules } from './lib.mjs';

export const RUBRIC = {
  C1: 'Contradicted: lead `done` of p…a1 ended that run only; later id-less turns (extension work) continued, and the agreed marker FINAL-OK came after. And the artifact misses the required "Risks" section, so the team result is not complete. Next: fix/finish the artifact before closing.',
  C2: 'Cannot determine: `external type=link` with the run id says only that a link message entered lead\'s context during that run, not who sent it or that it caused the fix. Next: read the session file for the message content and sender.',
  C3: 'Contradicted: `run_failed` ended that run only; the agent stayed on (later queued/run/done of p…f6), so no restart was needed then. Next step at that point: check whether c3 is still needed (and what it did) and resend it if so. Also fine: noting that the log later ends in `failed` (p…e5), so today the agent is off.',
  C4: 'Contradicted: `dropped` p…d4 never ran, so nothing to clean up. Next: resend it if still needed.',
  C5: 'Contradicted / unsafe: p…e5 was cut short by `failed` after text saying step 1 was being applied; it may have partially run. Next: inspect the logs and the database/artifacts before resending; do not just resend.',
  C6: 'Contradicted: `diagnostic` and `extension_error` do not change the state; later runs completed with `done`, and these events are not state transitions; the log does not establish the cause of the later `failed` during p…e5. Next: fix the unknown flag / missing module if those features matter; the boot itself needed no recovery.',
};

const ts = (second) => `2026-11-01T10:00:${String(second).padStart(2, '0')}.000Z`;
const line = (second, event) => JSON.stringify({ ts: ts(second), ...event });

export async function setup({ attempt }) {
  const snap = path.join(attempt.work, 'snapshot');
  await fs.mkdir(path.join(snap, 'artifact'), { recursive: true });
  const lead = 'team-lead';
  await fs.writeFile(path.join(snap, `${lead}.log`), [
    line(0, { event: 'spawned', pid: 4100 }),
    line(1, { event: 'queued', id: 'p0000000000a1' }),
    line(1, { event: 'run', id: 'p0000000000a1' }),
    line(2, { event: 'turn', id: 'p0000000000a1' }),
    line(3, { event: 'text', id: 'p0000000000a1', text: 'Mission received. I have asked the writer and the checker to start; I will collect their results.' }),
    line(4, { event: 'done', id: 'p0000000000a1' }),
    line(10, { event: 'turn' }),
    line(11, { event: 'external', type: 'link' }),
    line(12, { event: 'text', text: 'The writer delivered a draft. Waiting for the checker.' }),
    line(20, { event: 'queued', id: 'p0000000000b2' }),
    line(20, { event: 'run', id: 'p0000000000b2' }),
    line(21, { event: 'turn', id: 'p0000000000b2' }),
    line(22, { event: 'external', id: 'p0000000000b2', type: 'link' }),
    line(23, { event: 'text', id: 'p0000000000b2', text: 'Fixed the totals table in report.md.' }),
    line(24, { event: 'done', id: 'p0000000000b2' }),
    line(30, { event: 'turn' }),
    line(31, { event: 'text', text: 'FINAL-OK: report.md is ready.' }),
    '',
  ].join('\n'));
  await fs.writeFile(path.join(snap, 'worker-db.log'), [
    line(0, { event: 'spawned', pid: 4200 }),
    line(0, { event: 'diagnostic', type: 'error', message: 'Unknown flag --x verbose' }),
    line(0, { event: 'extension_error', extension: 'C:/ext/metrics.js', on: 'load', reason: 'Cannot find module ./stats' }),
    line(1, { event: 'queued', id: 'p0000000000c3' }),
    line(1, { event: 'run', id: 'p0000000000c3' }),
    line(2, { event: 'turn', id: 'p0000000000c3' }),
    line(3, { event: 'run_failed', id: 'p0000000000c3', reason: '529 overloaded' }),
    line(5, { event: 'queued', id: 'p0000000000f6' }),
    line(5, { event: 'run', id: 'p0000000000f6' }),
    line(6, { event: 'turn', id: 'p0000000000f6' }),
    line(7, { event: 'text', id: 'p0000000000f6', text: 'Indexes rebuilt.' }),
    line(8, { event: 'done', id: 'p0000000000f6' }),
    line(20, { event: 'queued', id: 'p0000000000e5' }),
    line(20, { event: 'queued', id: 'p0000000000d4' }),
    line(20, { event: 'run', id: 'p0000000000e5' }),
    line(21, { event: 'turn', id: 'p0000000000e5' }),
    line(22, { event: 'text', id: 'p0000000000e5', text: 'Applying migration step 1 of 3 to the orders table.' }),
    line(23, { event: 'turn', id: 'p0000000000e5' }),
    line(25, { event: 'dropped', ids: ['p0000000000d4'] }),
    line(25, { event: 'failed', id: 'p0000000000e5', reason: 'process exited unexpectedly' }),
    '',
  ].join('\n'));
  await fs.writeFile(path.join(snap, 'artifact', 'spec.md'), '# Report spec\n\nreport.md must have these sections: Summary, Totals, Risks.\n');
  await fs.writeFile(path.join(snap, 'artifact', 'report.md'), '# Report\n\n## Summary\n\nQ3 went well.\n\n## Totals\n\n| Item | Value |\n| --- | --- |\n| Revenue | 1.2M |\n');
  await fs.writeFile(path.join(snap, 'claims.md'), [
    '# Previous operator\'s closing report',
    '',
    'The team agreed that the lead would write a line starting with FINAL-OK when the work was complete.',
    '',
    `- C1. The team finished when ${lead}'s prompt p0000000000a1 ended with done, and report.md is complete.`,
    `- C2. The checker's link message caused the totals fix in p0000000000b2.`,
    '- C3. worker-db crashed when prompt p0000000000c3 failed, so it had to be restarted.',
    '- C4. Prompt p0000000000d4 partially ran; its changes need to be cleaned up.',
    '- C5. Prompt p0000000000e5 did nothing, so it is safe to simply send it again.',
    '- C6. worker-db was broken from boot: the diagnostic and the extension error put it in a failed state.',
    '',
  ].join('\n'));
  return { snap };
}

export function prompt({ attempt }, state) {
  return `You are auditing another operator's closing report about a team of pi-dock agents (pi-dock runs resident Pi agents in the background). The agents no longer exist; you have copies of their pi-dock event logs (the raw NDJSON pi-dock stores), the team's artifact and its spec, and the report, all in ${state.snap}:

- team-lead.log, worker-db.log: the agents' event logs
- artifact/spec.md, artifact/report.md: what the team had to produce, and what it produced
- claims.md: the operator's claims C1 to C6

For each claim, decide whether the evidence supports it, contradicts it, or cannot determine it; cite the log lines or files that show it; and give the minimal next step an operator should have taken at the point the claim refers to (note it if something later in the log changes that). Where the evidence is not enough, say so instead of guessing. Write your audit to ${path.join(attempt.work, 'answer.md')}, as one section per claim.

This is a reading task: no pi-dock command is needed. ${evalRules(attempt, { operating: false })}
`;
}

export async function measure({ attempt }) {
  let answer = null;
  try {
    answer = await fs.readFile(path.join(attempt.work, 'answer.md'), 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
  return { answerWritten: { pass: answer !== null }, rubric: RUBRIC, answer };
}
