#!/usr/bin/env node
// Docker stack of the active app. up, down and e2e hold the stack lock (checks/lib/lock.mjs): one stack operation at
// a time; a second one waits --lock-wait seconds, then exits 3 "STACK BUSY". Never delete a live lock.
//   up      docker compose up -d --build, then wait until backend health and frontend answer. The build is skipped when
//           the image inputs (checks/lib/hash.mjs) equal those of the last successful up (stack-hash.json); --build forces it
//   down    docker compose down --remove-orphans over every mode; afterwards no container of the project may be left
//           (leftovers are removed and reported)
//   status  docker compose ps (no lock)
//   --mode e2e|run   which stack (.oracul/stack.json, checks/lib/stack.mjs): e2e (default — what the workflows test)
//           or run (what the user starts). Without a config: plain docker compose; extra compose files without a
//           config → refused (exit 1) instead of guessing which stack E2E would hit.
//   e2e     up (unless --no-up) + Playwright; screenshots → docs/<phase>/05_release/qa/screenshots;
//           on failure prints the "E2E FAILURES" block last
//   e2e --scratch --grep <spec file | title pattern>
//           tester verification run (test-fix only, hook-enforced): same lock and build, scoped to the pattern,
//           writes e2e/report-scratch + e2e/test-results-scratch — never official reports, traces or screenshots
//   e2e --detach  start the official Playwright run in a background worker (it holds the lock) and return at once —
//           a full suite outlives the 10-minute command limit of the workflow runner
//   e2e-wait [--max <s>]  wait up to --max seconds (default 480) for the detached run: its output + exit code when
//           done, exit 75 "E2E STILL RUNNING" otherwise (call again), exit 4 "E2E WORKER LOST" if the worker died
//   e2e --focus-slice <s> [--detach]  focus run of a fix round (workflow): only the slice's related E2E specs + the
//           specs that failed last time (checks/lib/e2e.mjs e2eFocus); writes e2e/report-focus + test-results-focus,
//           never official evidence. Exit 5 FOCUS UNSUPPORTED (config without E2E_REPORT_DIR/E2E_OUTPUT_DIR — run the
//           official full E2E instead), exit 6 FOCUS EMPTY (nothing to focus on — run the official full E2E).
//   An official full run records { hash of the tested inputs, exit code } in state/apps/<app>/e2e-last.json
//   (checks/check-e2e-fresh.mjs compares it with the current code).
//   --lock-wait <s>  default 60 (120 for --scratch) · --dry-run  check preconditions + lock, print the plan, no Docker
//   ORACUL_E2E_CMD='["cmd","arg"]'  replaces `npx playwright test` (self-test seam; never set it in a real run)
// Exit: 0 ok · 1 failure · 3 stack busy (another stack operation holds the lock) · 4 worker lost · 5 focus unsupported
//       · 6 focus empty · 75 still running
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { context, e2eLastPath, e2eRunPath, parseArgs, readJson, run, stackHashPath, stackLockPath, tail, took, writeJson } from '../checks/lib/core.mjs';
import { FOCUS, SCRATCH, e2eEnv, e2eFocus, failureBlock, filterArgs, scratchEnvProblems, scratchSupported } from '../checks/lib/e2e.mjs';
import { e2eInputsHash, imageInputsHash } from '../checks/lib/hash.mjs';
import { acquire, alive } from '../checks/lib/lock.mjs';
import { STACK_CONFIG, composeArgs, extraComposeFiles, loadStackConfig, projectName } from '../checks/lib/stack.mjs';

const args = parseArgs();
const ctx = context(args);
const cmd = args._[0];
if (!ctx.appDir) { console.error('stack: no active app'); process.exit(1); }
const mode = typeof args.mode === 'string' ? args.mode : 'e2e';
if (!['e2e', 'run'].includes(mode)) { console.error('stack: --mode must be e2e or run'); process.exit(1); }
const stack = loadStackConfig(ctx.appDir);
if (stack.problems.length) { for (const p of stack.problems) console.error(`stack: ${p}`); process.exit(1); }
const stackCfg = stack.config;
const URLS = { frontend: stackCfg?.urls?.frontend || 'http://localhost:4200', backend: stackCfg?.urls?.health || 'http://localhost:8080/actuator/health' };
// Refuse to guess: extra compose files (e.g. docker-compose.e2e.yml) without declared modes.
function ambiguity() {
  const extra = stackCfg ? [] : extraComposeFiles(ctx.appDir);
  return extra.length ? `extra compose file(s) ${extra.join(', ')} but no ${STACK_CONFIG} — the analyst declares the e2e and run modes; never run docker compose yourself` : null;
}
const scratch = !!args.scratch;
const focusSlice = typeof args['focus-slice'] === 'string' ? args['focus-slice'] : null;
const kind = scratch ? 'scratch' : focusSlice ? 'focus' : 'official';
const lockWait = args['lock-wait'] !== undefined ? Number(args['lock-wait']) : scratch ? 120 : 60;
const appName = ctx.app || path.basename(ctx.appDir);
const RUN = { status: e2eRunPath(appName, 'json'), log: e2eRunPath(appName, 'log') };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readLog = () => { try { return fs.readFileSync(RUN.log, 'utf8'); } catch { return ''; } };

const composeCmd = (action, a) => ['compose', ...composeArgs(stackCfg, action, mode), ...a];
function compose(...a) {
  const r = run('docker', composeCmd(a[0], a), { cwd: ctx.appDir });
  if (r.code) { console.error(tail(r.out, 80)); process.exit(r.code === 3 ? 1 : r.code); }
  return r.out;
}

async function waitUp(timeoutS = 300) {
  const t0 = Date.now();
  const ok = async (u) => { try { return (await fetch(u)).ok; } catch { return false; } };
  while (Date.now() - t0 < timeoutS * 1000) {
    if ((await ok(URLS.backend)) && (await ok(URLS.frontend))) return true;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
}

// Rebuild only when something that goes into the images changed since the last successful up.
function buildPlan() {
  const hash = imageInputsHash(ctx.appDir);
  const prev = readJson(stackHashPath(appName));
  const why = args.build ? '--build given' : !prev ? 'no record of the built images' : prev.hash !== hash ? 'image inputs changed' : null;
  return { hash, build: !!why, why: why || 'images current — no rebuild' };
}

async function up() {
  const t0 = Date.now();
  const plan = buildPlan();
  console.log(`docker ${composeCmd('up', ['up', '-d', ...(plan.build ? ['--build'] : [])]).join(' ')} … (${plan.why}; mode ${mode})`);
  compose('up', '-d', ...(plan.build ? ['--build'] : []));
  if (!(await waitUp())) {
    console.error('stack did not become healthy within 300s');
    console.error(tail(run('docker', composeCmd('logs', ['logs', '--tail', '60']), { cwd: ctx.appDir }).out, 80));
    process.exit(1);
  }
  // Every service of the mode must be running (e.g. the stub of the e2e mode).
  const want = compose('config', '--services').split('\n').map((x) => x.trim()).filter(Boolean);
  const running = new Set(compose('ps', '--services', '--status', 'running').split('\n').map((x) => x.trim()).filter(Boolean));
  const missing = want.filter((x) => !running.has(x));
  if (missing.length) { console.error(`stack: services of mode ${mode} not running: ${missing.join(', ')}`); process.exit(1); }
  writeJson(stackHashPath(appName), { hash: plan.hash, at: new Date().toISOString() });
  console.log(`UP  frontend ${URLS.frontend}  ·  backend http://localhost:8080/api  ·  health ${URLS.backend}  (took ${took(Date.now() - t0)})`);
}

async function locked(name, onBusy = () => {}) {
  const l = await acquire(stackLockPath(appName), name, { waitS: lockWait });
  if (!l.ok) {
    console.error(`STACK BUSY: ${l.holder.cmd} by pid ${l.holder.pid} since ${l.holder.startedAt}`);
    onBusy();
    process.exit(3);
  }
  const quit = (code) => () => { l.release(); process.exit(code); };
  process.once('SIGINT', quit(130));
  process.once('SIGTERM', quit(143));
  return l;
}

function preconditions() {
  if (!scratch) return [];
  const problems = [];
  if (typeof args.grep !== 'string' || !args.grep) problems.push('--scratch needs --grep <spec file | title pattern> (scoped runs only)');
  const cfg = fs.readFileSync(path.join(ctx.appDir, 'e2e', 'playwright.config.ts'), 'utf8');
  if (!scratchSupported(cfg)) problems.push('scratch runs need E2E_REPORT_DIR/E2E_OUTPUT_DIR support in e2e/playwright.config.ts — migration pending (migrate.mjs at the next slice boundary). Do not run Playwright yourself; the workflow\'s official E2E step covers this round');
  problems.push(...scratchEnvProblems(e2eEnv({ appDir: ctx.appDir, phaseDir: ctx.phaseDir, scratch }), ctx.appDir));
  return problems;
}

// Start the official run in a detached worker; return once the worker holds the lock (or is refused).
async function detach() {
  writeJson(RUN.status, { state: 'starting', startedAt: new Date().toISOString() });
  const fd = fs.openSync(RUN.log, 'w');
  const pass = ['app', 'app-dir', 'phase', 'lock-wait', 'focus-slice'].flatMap((k) => (args[k] !== undefined ? [`--${k}`, String(args[k])] : []));
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'e2e', '--worker', '--no-up', ...pass], { detached: true, stdio: ['ignore', fd, fd], env: process.env });
  child.unref();
  fs.closeSync(fd);
  const t0 = Date.now();
  while (Date.now() - t0 < (lockWait + 30) * 1000) {
    const st = readJson(RUN.status) || {};
    if (st.state === 'running' || st.state === 'done') { console.log(`E2E STARTED (worker pid ${child.pid}) — log ${RUN.log}; collect with: stack.mjs e2e-wait`); process.exit(0); }
    if (st.state === 'busy') { console.log(tail(readLog(), 5)); process.exit(3); }
    if (!alive(child.pid)) { console.log(tail(readLog(), 30)); console.log('E2E WORKER LOST: the worker exited before it started'); process.exit(4); }
    await sleep(300);
  }
  console.log(`E2E WORKER LOST: no start within ${lockWait + 30}s`);
  process.exit(4);
}

// Wait for the detached run: its output + exit code when done, 75 while it still runs, 4 if the worker died.
async function waitRun(maxS) {
  const t0 = Date.now();
  for (;;) {
    const st = readJson(RUN.status);
    if (!st) { console.error('stack e2e-wait: no detached E2E run (start one with stack.mjs e2e --detach)'); process.exit(1); }
    if (st.state === 'done') { console.log(tail(readLog(), 70)); process.exit(st.code === 0 ? 0 : 1); }
    if (st.state === 'busy') { console.log(tail(readLog(), 5)); process.exit(3); }
    const lost = st.state === 'running' ? !alive(st.pid) : Date.now() - Date.parse(st.startedAt) > 120_000;
    if (lost) { console.log(tail(readLog(), 30)); console.log(`E2E WORKER LOST: ${st.state === 'running' ? `worker pid ${st.pid} is gone` : 'the worker never started'} — log ${RUN.log}`); process.exit(4); }
    if ((Date.now() - t0) / 1000 >= maxS) {
      console.log(tail(readLog(), 3));
      console.log(`E2E STILL RUNNING (${Math.round((Date.now() - Date.parse(st.startedAt)) / 1000)}s since start) — call stack.mjs e2e-wait again`);
      process.exit(75);
    }
    await sleep(Math.min(5000, Math.max(200, maxS * 1000 - (Date.now() - t0))));
  }
}

switch (cmd) {
  case 'up': {
    const amb = ambiguity();
    if (amb) { console.error(`stack up: ${amb}`); process.exit(1); }
    const l = await locked('up');
    if (args['dry-run']) { const p = buildPlan(); console.log(`DRY RUN (lock held): docker ${composeCmd('up', ['up', '-d', ...(p.build ? ['--build'] : [])]).join(' ')} (${p.why})`); l.release(); process.exit(0); }
    await up();
    break;
  }
  case 'down': {
    const l = await locked('down');
    const cmdArgs = composeCmd('down', ['down', '--remove-orphans']);
    if (args['dry-run']) { console.log(`DRY RUN (lock held): docker ${cmdArgs.join(' ')}`); l.release(); process.exit(0); }
    compose('down', '--remove-orphans');
    // Nothing of the project may be left (a container of a mode or profile the down did not cover).
    const project = projectName(ctx.appDir, stackCfg);
    const left = run('docker', ['ps', '-a', '-q', '--filter', `label=com.docker.compose.project=${project}`]).out.split('\n').map((x) => x.trim()).filter(Boolean);
    if (left.length) { run('docker', ['rm', '-f', ...left]); console.log(`down: removed ${left.length} leftover container(s) of project ${project}`); }
    console.log('down');
    break;
  }
  case 'status': console.log(compose('ps')); break;
  case 'e2e-wait': await waitRun(args.max !== undefined ? Number(args.max) : 480); break;
  case 'e2e': {
    const bad = preconditions();
    const amb = args['no-up'] ? null : ambiguity();
    if (amb) bad.push(amb);
    if (args.detach && scratch) bad.push('--detach is for the official run only (scratch runs are scoped and short)');
    if (scratch && focusSlice) bad.push('--scratch and --focus-slice exclude each other');
    if (bad.length) { for (const b of bad) console.error(`stack e2e: ${b}`); process.exit(1); }
    let focusFiles = [];
    if (focusSlice) {
      const cfg = fs.readFileSync(path.join(ctx.appDir, 'e2e', 'playwright.config.ts'), 'utf8');
      if (!scratchSupported(cfg)) { console.log('FOCUS UNSUPPORTED: e2e/playwright.config.ts lacks E2E_REPORT_DIR/E2E_OUTPUT_DIR support — migration pending (migrate.mjs at the next slice boundary). Run the official full E2E instead; never run Playwright yourself.'); process.exit(5); }
      const fp = scratchEnvProblems(e2eEnv({ appDir: ctx.appDir, phaseDir: ctx.phaseDir, kind: 'focus' }), ctx.appDir);
      if (fp.length) { console.error(`stack e2e: ${fp.join('; ')}`); process.exit(1); }
      focusFiles = e2eFocus({ appDir: ctx.appDir, phaseDir: ctx.phaseDir, slice: focusSlice });
      if (!focusFiles.length) { console.log(`FOCUS EMPTY: no related or failed E2E spec for ${focusSlice} — run the official full E2E`); process.exit(6); }
      console.log(`FOCUS ${focusSlice}: ${focusFiles.join(' ')}`);
    }
    if (args.detach && !args['dry-run']) await detach();
    const worker = !!args.worker;
    const l = await locked(scratch ? 'e2e --scratch' : focusSlice ? 'e2e --focus' : 'e2e', () => worker && writeJson(RUN.status, { state: 'busy', pid: process.pid }));
    if (worker) writeJson(RUN.status, { state: 'running', pid: process.pid, startedAt: new Date().toISOString() });
    const env = e2eEnv({ appDir: ctx.appDir, phaseDir: ctx.phaseDir, kind });
    const pwArgs = ['playwright', 'test', ...(scratch ? filterArgs(args.grep) : focusSlice ? focusFiles : [])];
    const override = process.env.ORACUL_E2E_CMD ? JSON.parse(process.env.ORACUL_E2E_CMD) : null;
    if (args['dry-run']) {
      console.log(`DRY RUN (lock held): ${args['no-up'] ? '' : `docker ${composeCmd('up', ['up', '-d', '--build']).join(' ')} && `}npx ${pwArgs.join(' ')}`);
      console.log(Object.entries(env).map(([k, v]) => `  ${k}=${v}`).join('\n'));
      l.release();
      process.exit(0);
    }
    if (!args['no-up']) await up();
    const e2eDir = path.join(ctx.appDir, 'e2e');
    const tested = kind === 'official' ? e2eInputsHash(ctx.appDir) : null; // what this run tests (images are built)
    const tE = Date.now();
    const r = override
      ? run(override[0], override.slice(1), { cwd: e2eDir, env: { ...process.env, ...env, CI: 'true' } })
      : run('npx', pwArgs, { cwd: e2eDir, env: { ...process.env, ...env, CI: 'true' } });
    const reportDir = scratch ? SCRATCH.report : focusSlice ? FOCUS.report : 'report';
    const block = r.code ? failureBlock(readJson(path.join(e2eDir, reportDir, 'results.json')), ctx.appDir) : '';
    console.log(tail(r.out, block ? 15 : 60));
    console.log(`Playwright took ${took(Date.now() - tE)}`);
    if (tested) writeJson(e2eLastPath(appName), { hash: tested, code: r.code ? 1 : 0, at: new Date().toISOString() });
    const label = scratch ? 'SCRATCH ' : focusSlice ? 'FOCUS ' : '';
    const note = scratch ? ' (not evidence — the workflow E2E step decides)' : focusSlice ? ' (related specs only — the full E2E run is the slice gate)' : '';
    console.log(`${label}${r.code ? 'E2E FAIL' : 'E2E PASS'}${note}`);
    if (block) console.log(block);
    if (worker) writeJson(RUN.status, { state: 'done', code: r.code ? 1 : 0, pid: process.pid, finishedAt: new Date().toISOString() });
    l.release();
    process.exit(r.code ? 1 : 0);
  }
  default:
    console.error('usage: stack.mjs up|down|status|e2e|e2e-wait [--no-up] [--detach] [--scratch --grep <pattern>] [--focus-slice <s>] [--max <s>] [--lock-wait <s>] [--dry-run]');
    process.exit(1);
}
