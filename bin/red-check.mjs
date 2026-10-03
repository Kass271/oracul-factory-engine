#!/usr/bin/env node
// Step 4b proof: the slice's new tests exist, are tagged, and FAIL for the right reason (assertion / missing
// behaviour) — not because the code does not compile and not because the test itself is buggy (see checks/lib/red.mjs:
// test-bug signatures, older tests broken by the new ones, superseded tests not updated, ranges without an
// exhaustive test). Writes docs/<phase>/04_build/<slice>/red-evidence.md. The tester runs it as a self-check
// before finishing; the orchestrator's run is the gate.
//   --slice <s>
// Exit 0 = valid RED · 1 = not red (tests pass, missing, or not updated) · 2 = red for the wrong reason
import fs from 'node:fs';
import path from 'node:path';
import { context, parseArgs, run, tail, today } from '../checks/lib/core.mjs';
import { collectTraces, parsePlan } from '../checks/lib/docs.mjs';
import { analyseRed } from '../checks/lib/red.mjs';

const args = parseArgs();
const ctx = context(args);
const slice = args.slice;
if (!slice || !ctx.phaseDir) { console.error('red-check: --slice required and an active app/phase'); process.exit(1); }
const s = (parsePlan(ctx.phaseDir) || []).find((p) => p.slice === slice);
if (!s) { console.error(`red-check: ${slice} not in plan`); process.exit(1); }

const traces = collectTraces(ctx.appDir);
const testLayers = [...new Set(s.frs.flatMap((f) => (traces.get(f) || []).map((t) => t.layer)))].filter((l) => l !== 'e2e');
const since = Date.now() - 1000;
const layers = {};
for (const layer of testLayers) {
  const cwd = path.join(ctx.appDir, layer);
  layers[layer] = layer === 'backend'
    ? run('./gradlew', ['test', '--console=plain', '--continue'], { cwd })
    : run('npm', ['run', 'test:ci', '--silent'], { cwd, env: { ...process.env, CI: 'true' } });
}
// Test files the tester added or changed (null when git is not available → those checks are skipped).
const g = run('git', ['-C', ctx.appDir, 'status', '--porcelain', '--untracked-files=all', '--', 'backend/src/test', 'frontend/src', 'e2e/tests']);
const changed = g.code === 0 ? g.out.split('\n').filter(Boolean).map((l) => l.slice(3).replace(/^.* -> /, '').replace(/^"|"$/g, '')) : null;

const a = analyseRed({ appDir: ctx.appDir, phaseDir: ctx.phaseDir, slice, layers, since, changed });
const md = [
  `# Red evidence — ${slice}`,
  '',
  `Date: ${today()} · FRs: ${s.frs.join(', ')}`,
  '',
  '## Tagged tests',
  '',
  ...a.sliceTests.map((t) => `- ${t.fr} → \`${t.rel}\` (${t.layer})`),
  ...a.untagged.map((f) => `- ${f} → MISSING: no test tagged "@trace ${f}"`),
  '',
  ...(a.notRed.length || a.wrong.length ? ['## Problems', '', ...a.notRed.map((p) => `- NOT-RED: ${p}`), ...a.wrong.map((p) => `- WRONG-REASON: ${p}`), ''] : []),
  ...a.layers.map((l) => `## ${l.layer}\n\n- Command exit: ${l.code}\n- Classification: ${l.cls}\n\n\`\`\`\n${tail(l.out, 50)}\n\`\`\`\n`),
  `RESULT: ${a.verdict}`,
  '',
].join('\n');
const out = path.join(ctx.phaseDir, '04_build', slice, 'red-evidence.md');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, md);
let fence = false; // print everything but the raw command output
console.log(md.split('\n').filter((l) => (l.startsWith('```') ? (fence = !fence, false) : !fence && !l.startsWith('RESULT:'))).join('\n'));
console.log(`RESULT: ${a.verdict} → ${path.relative(ctx.appDir, out)}`);
process.exit(a.verdict === 'RED' ? 0 : a.verdict === 'WRONG-REASON' ? 2 : 1);
