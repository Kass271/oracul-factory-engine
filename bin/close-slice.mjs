#!/usr/bin/env node
// The ONE way a slice becomes DONE — used by the build-slice workflow and by the orchestrator's takeover after round 3.
// Deterministic, in this order, stopping at the first failure ("CLOSE FAILED at <step>"), nothing committed then:
//   1. slice gate (unless --check-only): verify --incremental (stale layers in full) + official E2E of every spec not
//      green on the current inputs (stack.mjs up --mode e2e, e2e --needed; synchronous — run it in the background
//      from a session, the workflow uses --check-only after its own detached E2E)
//   2. check-docs (shell syntax of changed docs)       3. check-review --slice (no open blocking finding)
//   4. check-e2e-fresh (every E2E spec green on the current inputs; --allow-missing for apps without any record)
//   5. verify --reuse-if-fresh (a full GREEN verify on the current inputs)   6. check-artifacts --stage done
//   7. check-coverage --update   8. commit "<phase> <slice>: done (<FRs>)"   9. slice DONE, subStep none
//   10. retro (bin/retro.mjs, if present; never fails the close)
//   --slice <s> [--check-only] [--dry-run]
import fs from 'node:fs';
import path from 'node:path';
import { ENGINE, context, parseArgs, run } from '../checks/lib/core.mjs';
import { parsePlan } from '../checks/lib/docs.mjs';

const args = parseArgs();
const ctx = context(args);
const S = args.slice;
if (!ctx.appDir || !ctx.phaseDir || typeof S !== 'string') { console.error('close-slice: --slice <s> and an active app/phase are required'); process.exit(1); }
const plan = (parsePlan(ctx.phaseDir) || []).find((p) => p.slice === S);
if (!plan) { console.error(`close-slice: ${S} is not in the plan`); process.exit(1); }
const pass = ['app', 'app-dir', 'phase'].flatMap((k) => (args[k] ? [`--${k}`, String(args[k])] : []));
const n = (script, ...a) => ['node', [path.join(ENGINE, script), ...a, ...pass]];

const steps = [
  ...(args['check-only'] ? [] : [
    ['slice gate: verify (stale layers in full)', ...n('checks/verify.mjs', '--incremental')],
    ['slice gate: state → e2e', ...n('bin/state.mjs', 'set', 'subStep', 'e2e')],
    ['slice gate: stack up', ...n('bin/stack.mjs', 'up', '--mode', 'e2e')],
    ['slice gate: E2E (specs not green on the current inputs)', ...n('bin/stack.mjs', 'e2e', '--needed', '--no-up')],
  ]),
  ['docs syntax', ...n('checks/check-docs.mjs')],
  ['review', ...n('checks/check-review.mjs', '--slice', S)],
  ['E2E covers the current code', ...n('checks/check-e2e-fresh.mjs', '--allow-missing')],
  ['full verify on the current inputs', ...n('checks/verify.mjs', '--reuse-if-fresh')],
  ['artifacts', ...n('checks/check-artifacts.mjs', '--step', '04_build', '--slice', S, '--stage', 'done')],
  ['coverage ratchet', ...n('checks/check-coverage.mjs', '--update')],
  ['commit', ...n('bin/commit.mjs', '--message', `${ctx.phase} ${S}: done (${plan.frs.join(', ')})`)],
  ['slice DONE', ...n('bin/state.mjs', 'slice', S, 'DONE')],
  ['subStep none', ...n('bin/state.mjs', 'set', 'subStep', 'none')],
];
if (args['dry-run']) { steps.forEach(([label, cmd, a], i) => console.log(`${i + 1}. ${label}: ${cmd} ${a.map((x) => path.relative(ENGINE, x).startsWith('..') ? x : path.relative(ENGINE, x)).join(' ')}`)); process.exit(0); }
for (const [label, cmd, a] of steps) {
  const r = run(cmd, a, { cwd: ctx.appDir });
  console.log(`\n-- ${label} --\n${r.out.trim()}`);
  if (r.code !== 0) { console.log(`\nCLOSE FAILED at "${label}" — nothing committed, the slice stays IN_PROGRESS`); process.exit(1); }
}
const retro = path.join(ENGINE, 'bin', 'retro.mjs');
if (fs.existsSync(retro)) { const r = run('node', [retro, '--slice', S, ...pass], { cwd: ctx.appDir }); console.log(`\n-- retro --\n${r.out.trim()}`); }
console.log(`\nCLOSED ${S}: DONE and committed`);
