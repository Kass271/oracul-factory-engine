#!/usr/bin/env node
// Compile only — backend main/tests (Gradle), frontend app/specs (tsc) — and print the compiler's diagnostics verbatim
// with a label each: main · generated · test-new · test-old · unknown (checks/lib/compile.mjs).
//   --layer backend|frontend|all     (default all)
//   --stage main|tests|all           (default all; tests needs main)
//   --if-contract-changed            exit 0 at once when api/openapi.yaml is unchanged since the last finished slice
//                                    (or the setup) — nothing a contract change could break
//   --slice <s> --require-listed     every older test (test-old) that does not compile must be listed under
//                                    "Changes earlier behaviour" of the slice's FRs → UNLISTED lines, exit 1
// Exit 0 = compiles (or nothing to check) · 1 = does not compile / unlisted older tests
import path from 'node:path';
import { context, parseArgs, run } from '../checks/lib/core.mjs';
import { compileSteps, contractChanged, diagnostics, runCompile, summaryLine } from '../checks/lib/compile.mjs';
import { parsePlan, parseSpecFrs } from '../checks/lib/docs.mjs';

const args = parseArgs();
const ctx = context(args);
if (!ctx.appDir) { console.error('compile-check: no active app'); process.exit(1); }
const layers = !args.layer || args.layer === 'all' ? ['backend', 'frontend'] : [args.layer];
const stages = !args.stage || args.stage === 'all' ? ['main', 'tests'] : [args.stage];

if (args['if-contract-changed'] && !contractChanged(ctx.appDir)) { console.log('compile-check: api/openapi.yaml unchanged since the last finished slice — nothing to check'); process.exit(0); }

const g = run('git', ['-C', ctx.appDir, 'status', '--porcelain', '--untracked-files=all', '--', 'backend/src/test', 'frontend/src']);
const changed = g.code === 0 ? g.out.split('\n').filter(Boolean).map((l) => l.slice(3).replace(/^.* -> /, '').replace(/^"|"$/g, '')) : [];
const results = runCompile(ctx.appDir, compileSteps(ctx.appDir, layers, stages));
for (const r of results) console.log(`${r.skipped ? 'SKIP' : r.code ? 'FAIL' : 'PASS'}     ${r.layer} ${r.stage}${r.skipped ? ' (main does not compile)' : ''}`);
if (results.every((r) => r.code === 0)) { console.log('COMPILE OK'); process.exit(0); }

const d = diagnostics(ctx.appDir, results, changed);
console.log(summaryLine(d));
for (const f of d.files) console.log(`  ${f.label.padEnd(9)} ${f.rel}:${f.line}`);
console.log(d.verbatim.join('\n'));

if (args['require-listed'] && args.slice) {
  const s = (parsePlan(ctx.phaseDir) || []).find((p) => p.slice === args.slice);
  const specs = parseSpecFrs(ctx.phaseDir);
  const listed = new Set((s?.frs || []).flatMap((f) => (specs.get(f)?.changes || []).flatMap((c) => c.tests)));
  const unlisted = [...new Set(d.files.filter((f) => f.label === 'test-old' && !listed.has(f.rel)).map((f) => f.rel))];
  for (const u of unlisted) console.log(`UNLISTED ${u} — an older test no longer compiles after the contract change; list it under "Changes earlier behaviour (tests: …)"`);
}
process.exit(1);
