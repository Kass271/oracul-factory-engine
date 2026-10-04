#!/usr/bin/env node
// Step 4b proof: the slice's new tests exist, are tagged, and FAIL for the right reason (assertion / missing
// behaviour) — not because the code does not compile and not because the test itself is buggy (see checks/lib/red.mjs:
// test-bug signatures, older tests broken by the new ones, superseded tests not updated, ranges without an
// exhaustive test). Writes docs/<phase>/04_build/<slice>/red-evidence.md. The tester runs it as a self-check
// before finishing; the orchestrator's run is the gate.
//   --slice <s>
//   --scope slice|full   slice (development loop, what the workflow uses) = only the related tests
//                        (checks/lib/related.mjs); full (default) = every test of the slice's layers. The slice gate
//                        (full verify) runs everything later either way.
//   --dry-run            print the commands, run nothing, write nothing
// Exit 0 = valid RED · 1 = not red (tests pass, missing, or not updated) · 2 = red for the wrong reason
import fs from 'node:fs';
import path from 'node:path';
import { context, parseArgs, run, took } from '../checks/lib/core.mjs';
import { collectTraces, parsePlan } from '../checks/lib/docs.mjs';
import { analyseRed, renderEvidence } from '../checks/lib/red.mjs';
import { layerCommand, relatedTests } from '../checks/lib/related.mjs';

const args = parseArgs();
const ctx = context(args);
const slice = args.slice;
const scope = args.scope || 'full';
if (!slice || !ctx.phaseDir) { console.error('red-check: --slice required and an active app/phase'); process.exit(1); }
if (!['slice', 'full'].includes(scope)) { console.error('red-check: --scope must be slice or full'); process.exit(1); }
const s = (parsePlan(ctx.phaseDir) || []).find((p) => p.slice === slice);
if (!s) { console.error(`red-check: ${slice} not in plan`); process.exit(1); }

// Test files the tester added or changed (null when git is not available → those checks are skipped).
const g = run('git', ['-C', ctx.appDir, 'status', '--porcelain', '--untracked-files=all', '--', 'backend/src/test', 'frontend/src', 'e2e/tests']);
const changed = g.code === 0 ? g.out.split('\n').filter(Boolean).map((l) => l.slice(3).replace(/^.* -> /, '').replace(/^"|"$/g, '')) : null;

const traces = collectTraces(ctx.appDir);
const testLayers = [...new Set(s.frs.flatMap((f) => (traces.get(f) || []).map((t) => t.layer)))].filter((l) => l !== 'e2e');
const related = scope === 'slice' ? relatedTests({ appDir: ctx.appDir, phaseDir: ctx.phaseDir, slice, changed: changed || [] }) : null;
const plans = Object.fromEntries(testLayers.map((layer) => [layer, layerCommand(layer, ctx.appDir, related ? related[layer] : null)]));

if (args['dry-run']) {
  console.log(`DRY RUN red-check ${slice} (scope ${scope})`);
  for (const [layer, p] of Object.entries(plans)) console.log(`  ${layer}: ${p.cmd} ${p.args.join(' ')}${p.note ? `   # ${p.note}` : ''}`);
  process.exit(0);
}

const since = Date.now() - 1000;
const layers = {};
for (const [layer, p] of Object.entries(plans)) {
  const t0 = Date.now();
  if (p.note) console.log(`${layer}: ${p.note}`);
  layers[layer] = run(p.cmd, p.args, { cwd: path.join(ctx.appDir, layer), env: { ...process.env, CI: 'true' } });
  console.log(`${layer} tests (${p.scoped ? 'related' : 'whole layer'}) took ${took(Date.now() - t0)}`);
}

const a = analyseRed({ appDir: ctx.appDir, phaseDir: ctx.phaseDir, slice, layers, since, changed });
const md = renderEvidence(a, { slice, frs: s.frs, scope });
const out = path.join(ctx.phaseDir, '04_build', slice, 'red-evidence.md');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, md);
let fence = false; // print everything but the raw command output
console.log(md.split('\n').filter((l) => (l.startsWith('```') ? (fence = !fence, false) : !fence && !l.startsWith('RESULT:'))).join('\n'));
console.log(`RESULT: ${a.verdict} → ${path.relative(ctx.appDir, out)}`);
process.exit(a.verdict === 'RED' ? 0 : a.verdict === 'WRONG-REASON' ? 2 : 1);
