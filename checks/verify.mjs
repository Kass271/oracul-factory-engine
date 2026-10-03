#!/usr/bin/env node
// The one command behind every gate: build + unit/integration tests of both layers, then all checks.
//   --scope built|all   traceability scope (default built)
//   --quick             skip builds/tests, run the checks only (uses existing reports)
// Writes state/apps/<app>/last-run.json and state.lastVerify. Exit 0 = GREEN, 1 = RED.
import fs from 'node:fs';
import path from 'node:path';
import { ENGINE, STEPS, context, lastRunPath, loadState, parseArgs, run, saveState, tail, writeJson } from './lib/core.mjs';

const args = parseArgs();
const ctx = context(args);
if (!ctx.appDir) { console.error('verify: no app selected'); process.exit(1); }
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
console.log(`\n==== VERIFY ${result}${failing.length ? `: ${failing.join(' · ')}` : ''} ====`);
process.exit(failing.length ? 1 : 0);
