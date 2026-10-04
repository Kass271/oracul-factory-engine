#!/usr/bin/env node
// The one command behind every gate: build + unit/integration tests of both layers, then all checks.
//   --scope built|all   traceability scope (default built)
//   --quick             skip builds/tests, run the checks only (uses existing reports)
//   --reuse-if-fresh    (slice close) exit 0 at once if the last full GREEN verify still stands, else a normal full run
// Writes state/apps/<app>/last-run.json and state.lastVerify. Exit 0 = GREEN, 1 = RED.
import fs from 'node:fs';
import path from 'node:path';
import { ENGINE, STEPS, context, flakyPath, lastRunPath, loadState, parseArgs, run, saveState, tail, took, walk, writeJson } from './lib/core.mjs';
import { flakyCases, junitCases, recordFlaky } from './lib/red.mjs';
import { slowReport } from './lib/timing.mjs';

const args = parseArgs();
const ctx = context(args);
if (!ctx.appDir) { console.error('verify: no app selected'); process.exit(1); }

// --reuse-if-fresh: reuse the last full GREEN verify when nothing it measured can have changed since — no test or
// coverage output and no source file is newer than it. A partial test run after it (e.g. the reviewer's
// `gradlew test --tests X`) rewrites those reports from a subset; then this runs a full verify instead of letting the
// close step read a false coverage drop. The skip path writes nothing.
function staleReason() {
  const lv = ctx.state?.lastVerify;
  if (!lv) return 'no earlier verify';
  if (lv.result !== 'GREEN') return `the last verify is ${lv.result}`;
  if (lv.quick) return 'the last verify was --quick (no tests ran)';
  const at = Date.parse(lv.at);
  const rel = (p) => path.relative(ctx.appDir, p).split(path.sep).join('/');
  const newer = (dirs, keep) => dirs.flatMap((d) => walk(path.join(ctx.appDir, d), (p) => keep(rel(p)))).find((p) => fs.statSync(p).mtimeMs > at);
  const out = newer(['backend/build/test-results', 'backend/build/reports/jacoco', 'frontend/coverage'], () => true);
  if (out) return `test/coverage output changed after it (${rel(out)})`;
  const src = newer(['backend/src', 'frontend/src', 'e2e/tests', 'api'], (r) => !r.startsWith('frontend/src/app/api/'));
  if (src) return `source changed after it (${rel(src)})`;
  return null;
}
if (args['reuse-if-fresh']) {
  const why = staleReason();
  if (!why) { console.log(`verify: reusing the full GREEN verify of ${ctx.state.lastVerify.at}`); process.exit(0); }
  console.log(`verify: ${why} — running a full verify`);
}

const T0 = Date.now();
const pass = ['app', 'app-dir', 'phase'].flatMap((k) => (args[k] ? [`--${k}`, String(args[k])] : []));
const failing = [];
const layers = {};

function layer(name, cwd, cmd, cmdArgs) {
  if (!fs.existsSync(cwd)) { console.log(`SKIP     ${name}: ${path.relative(ctx.appDir, cwd)} not found`); return; }
  console.log(`\n== ${name}: ${cmd} ${cmdArgs.join(' ')} ==`);
  const t0 = Date.now();
  const res = run(cmd, cmdArgs, { cwd, env: { ...process.env, CI: 'true' } });
  layers[name] = { exit: res.code, seconds: Math.round((Date.now() - t0) / 1000), tail: tail(res.out, 40) };
  console.log(tail(res.out, res.code ? 60 : 8));
  console.log(`${res.code ? 'FAIL' : 'PASS'}     ${name} (${layers[name].seconds}s)`);
  if (res.code) failing.push(name);
}

if (!args.quick) {
  layer('backend', path.join(ctx.appDir, 'backend'), './gradlew', ['test', 'jacocoTestReport', '--console=plain', '-q']);
  layer('frontend', path.join(ctx.appDir, 'frontend'), 'npm', ['run', 'test:ci', '--silent']);
  writeJson(lastRunPath(ctx.app || 'fixture'), { at: new Date().toISOString(), layers });
  const xmlDir = path.join(ctx.appDir, 'backend/build/test-results/test');
  const slow = slowReport(xmlDir);
  if (slow) console.log(`\n${slow}`);
  // Tests that failed and passed on the retry (Gradle test-retry plugin): reported and recorded, never blocking (D8).
  const flaky = flakyCases(junitCases(xmlDir, T0)).map((c) => `${c.classname}.${c.name}`);
  for (const f of flaky) console.log(`FLAKY    ${f} (failed, then passed on retry — recorded, not blocking)`);
  if (flaky.length && ctx.app) recordFlaky(flakyPath(ctx.app), ctx.state?.slice || ctx.state?.step || null, flaky);
}

function check(name, extra = []) {
  const res = run('node', [path.join(ENGINE, 'checks', `${name}.mjs`), ...pass, ...extra]);
  console.log(`\n${res.out.trim()}`);
  if (res.code) failing.push(`${name}${extra.length ? ` ${extra.join(' ')}` : ''}`);
}

const stepIdx = STEPS.indexOf(ctx.state?.step ?? '00_setup');
check('check-traceability', ['--scope', args.scope || 'built']);
check('check-coverage');
check('check-contract', args.quick ? [] : ['--require-generated']);
if (stepIdx >= STEPS.indexOf('04_build')) check('check-review');
for (const s of STEPS.slice(0, Math.min(stepIdx, STEPS.indexOf('04_build')))) check('check-artifacts', ['--step', s]);
if (stepIdx >= STEPS.indexOf('04_build')) check('check-artifacts', ['--step', '04_build']);

const result = failing.length ? 'RED' : 'GREEN';
if (ctx.app && loadState(ctx.app)) {
  const st = loadState(ctx.app);
  st.lastVerify = { at: new Date().toISOString(), result, failing, quick: !!args.quick };
  saveState(ctx.app, st);
}
console.log(`\nverify took ${took(Date.now() - T0)}`);
console.log(`\n==== VERIFY ${result}${failing.length ? `: ${failing.join(' · ')}` : ''} ====`);
process.exit(failing.length ? 1 : 0);
