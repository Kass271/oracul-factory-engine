#!/usr/bin/env node
// SubagentStop: an agent may only finish when the artifacts of its stage exist (checked by script).
// Blocks once (exit 2, the agent continues with the list); never loops (stop_hook_active → allow).
//   02_specs              → specs + contract notes + openapi (FR coverage)
//   03_plan               → plan covers every FR exactly once (approval comes later from the user)
//   04_build / spec       → spec delta: every slice FR has its "Changes earlier behaviour" + "Ranges & invariants" lines
//   04_build / sync       → the contract sync added no behaviour (check-sync)
//   04_build / red        → every FR of the slice has a tagged test
//   04_build / test-fix   → every FR of the slice still has a tagged test
//   05_release / test-fix → every built FR still has a tagged test
//   04_build / review     → review-findings.json valid
//   05_release / review   → release review-findings.json valid
//   05_release / qa       → test-plan, acceptance-report, how-to-run
import path from 'node:path';
import { ENGINE, run } from '../checks/lib/core.mjs';
import { active, readInput } from './lib.mjs';

const OURS = ['analyst', 'tester', 'backend-builder', 'frontend-builder', 'reviewer', 'qa-documenter'];
const input = readInput();
if (input.stop_hook_active) process.exit(0);
const type = String(input.agent_type || input.subagent_type || '');
if (type && !OURS.some((n) => type === n || type.endsWith(`:${n}`))) process.exit(0);

const a = active();
if (!a) process.exit(0);
const { step, subStep, slice } = a.state;
const check = (name, extra) => run('node', [path.join(ENGINE, 'checks', `${name}.mjs`), ...extra]);

let res = null;
if (step === '02_specs') res = check('check-artifacts', ['--step', '02_specs']);
else if (step === '03_plan') res = check('check-artifacts', ['--step', '03_plan', '--skip-rule', 'approved']);
else if (step === '04_build' && subStep === 'spec' && slice) res = check('check-artifacts', ['--step', '04_build', '--slice', slice, '--stage', 'spec', '--only', '02_specs']);
else if (step === '04_build' && subStep === 'sync') res = check('check-sync', []);
else if (step === '04_build' && ['red', 'test-fix'].includes(subStep) && slice) res = check('check-traceability', ['--slice', slice]);
else if (step === '04_build' && subStep === 'review' && slice) res = check('check-artifacts', ['--step', '04_build', '--slice', slice, '--stage', 'review', '--only', 'review-findings']);
else if (step === '05_release' && subStep === 'test-fix') res = check('check-traceability', ['--scope', 'built']);
else if (step === '05_release' && subStep === 'review') res = check('check-artifacts', ['--step', '05_release', '--only', '05_release/review-findings', '--skip-rule', 'reviewClean']);
else if (step === '05_release' && subStep === 'qa') res = check('check-artifacts', ['--step', '05_release', '--only', 'test-plan,acceptance-report,how-to-run']);

if (res && res.code !== 0) {
  process.stderr.write(`[oracul] your stage is not finished — these artifacts are missing or invalid:\n${res.out.split('\n').filter((l) => /^(MISSING|INVALID)|^\s{2,}\S/.test(l)).join('\n')}\nCreate/fix them, then finish.\n`);
  process.exit(2);
}
process.exit(0);
