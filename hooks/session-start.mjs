#!/usr/bin/env node
// SessionStart: brief the session — principles, active app/phase/step/slice, last verify, next action.
// stdout of a SessionStart hook is added to the session context.
import { active } from './lib.mjs';

const a = active();
const lines = [
  '[Oracul factory loaded] Build apps only through the factory skill ("Start new phase development").',
  'Rules: checks before code · every FR traced to a test · a step is done only when its command exits 0 ·',
  'tests RED before code · the builder never reviews itself · user approves scope and plan · evidence is a file.',
  'factory-engine/ is read-only here; state changes only via `node factory-engine/bin/state.mjs`.',
];

if (!a) lines.push('No active app yet. Next: user says "Start new phase development: <idea>".');
else {
  const s = a.state;
  const done = Object.values(s.slices || {}).filter((v) => v === 'DONE').length;
  const blocked = Object.entries(s.slices || {}).filter(([, v]) => v === 'BLOCKED').map(([k]) => k);
  lines.push(
    `Active app: ${a.app} (${a.appDir})`,
    `Phase ${s.phase} · step ${s.step} · slice ${s.slice ?? '-'} · subStep ${s.subStep} · round ${s.round}`,
    `Slices: ${done}/${Object.keys(s.slices || {}).length} DONE${blocked.length ? ` · BLOCKED: ${blocked.join(', ')}` : ''}`,
    `Approvals: scope ${s.approvals?.scope ?? 'pending'} · plan ${s.approvals?.plan ?? 'pending'}`,
    `Last verify: ${s.lastVerify ? `${s.lastVerify.result} at ${s.lastVerify.at}${s.lastVerify.failing?.length ? ` (${s.lastVerify.failing.join(', ')})` : ''}` : 'never'}`,
    'To resume: invoke the factory skill and say "continue".',
  );
}
console.log(lines.join('\n'));
