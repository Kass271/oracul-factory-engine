#!/usr/bin/env node
// Docker stack of the active app. up, down and e2e hold the stack lock (checks/lib/lock.mjs): one stack operation at
// a time; a second one waits --lock-wait seconds, then exits 3 "STACK BUSY". Never delete a live lock.
//   up      docker compose up -d --build, then wait until backend health and frontend answer
//   down    docker compose down
//   status  docker compose ps (no lock)
//   e2e     up (unless --no-up) + Playwright; screenshots → docs/<phase>/05_release/qa/screenshots;
//           on failure prints the "E2E FAILURES" block last
//   e2e --scratch --grep <spec file | title pattern>
//           tester verification run (test-fix only, hook-enforced): same lock and build, scoped to the pattern,
//           writes e2e/report-scratch + e2e/test-results-scratch — never official reports, traces or screenshots
//   --lock-wait <s>  default 240 (120 for --scratch) · --dry-run  check preconditions + lock, print the plan, no Docker
// Exit: 0 ok · 1 failure · 3 stack busy (another stack operation holds the lock)
import fs from 'node:fs';
import path from 'node:path';
import { context, parseArgs, readJson, run, stackLockPath, tail } from '../checks/lib/core.mjs';
import { SCRATCH, e2eEnv, failureBlock, filterArgs, scratchEnvProblems, scratchSupported } from '../checks/lib/e2e.mjs';
import { acquire } from '../checks/lib/lock.mjs';

const args = parseArgs();
const ctx = context(args);
const cmd = args._[0];
if (!ctx.appDir) { console.error('stack: no active app'); process.exit(1); }
const URLS = { frontend: 'http://localhost:4200', backend: 'http://localhost:8080/actuator/health' };
const scratch = !!args.scratch;
const lockWait = args['lock-wait'] !== undefined ? Number(args['lock-wait']) : scratch ? 120 : 240;

function compose(...a) {
  const r = run('docker', ['compose', ...a], { cwd: ctx.appDir });
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

async function up() {
  console.log('docker compose up -d --build …');
  compose('up', '-d', '--build');
  if (!(await waitUp())) {
    console.error('stack did not become healthy within 300s');
    console.error(tail(run('docker', ['compose', 'logs', '--tail', '60'], { cwd: ctx.appDir }).out, 80));
    process.exit(1);
  }
  console.log(`UP  frontend ${URLS.frontend}  ·  backend http://localhost:8080/api  ·  health ${URLS.backend}`);
}

async function locked(name) {
  const l = await acquire(stackLockPath(ctx.app || path.basename(ctx.appDir)), name, { waitS: lockWait });
  if (!l.ok) {
    console.error(`STACK BUSY: ${l.holder.cmd} by pid ${l.holder.pid} since ${l.holder.startedAt}`);
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
  if (!scratchSupported(cfg)) problems.push('scratch runs need E2E_REPORT_DIR/E2E_OUTPUT_DIR support in e2e/playwright.config.ts');
  problems.push(...scratchEnvProblems(e2eEnv({ appDir: ctx.appDir, phaseDir: ctx.phaseDir, scratch }), ctx.appDir));
  return problems;
}

switch (cmd) {
  case 'up': await locked('up'); if (!args['dry-run']) await up(); break;
  case 'down': await locked('down'); if (!args['dry-run']) { compose('down'); console.log('down'); } break;
  case 'status': console.log(compose('ps')); break;
  case 'e2e': {
    const bad = preconditions();
    if (bad.length) { for (const b of bad) console.error(`stack e2e: ${b}`); process.exit(1); }
    const l = await locked(scratch ? 'e2e --scratch' : 'e2e');
    const env = e2eEnv({ appDir: ctx.appDir, phaseDir: ctx.phaseDir, scratch });
    const pwArgs = ['playwright', 'test', ...(scratch ? filterArgs(args.grep) : [])];
    if (args['dry-run']) {
      console.log(`DRY RUN (lock held): ${args['no-up'] ? '' : 'docker compose up -d --build && '}npx ${pwArgs.join(' ')}`);
      console.log(Object.entries(env).map(([k, v]) => `  ${k}=${v}`).join('\n'));
      l.release();
      process.exit(0);
    }
    if (!args['no-up']) await up();
    const e2eDir = path.join(ctx.appDir, 'e2e');
    const r = run('npx', pwArgs, { cwd: e2eDir, env: { ...process.env, ...env, CI: 'true' } });
    const block = r.code ? failureBlock(readJson(path.join(e2eDir, scratch ? SCRATCH.report : 'report', 'results.json')), ctx.appDir) : '';
    console.log(tail(r.out, block ? 15 : 60));
    console.log(`${scratch ? 'SCRATCH ' : ''}${r.code ? 'E2E FAIL' : 'E2E PASS'}${scratch ? ' (not evidence — the workflow E2E step decides)' : ''}`);
    if (block) console.log(block);
    l.release();
    process.exit(r.code ? 1 : 0);
  }
  default:
    console.error('usage: stack.mjs up|down|status|e2e [--no-up] [--scratch --grep <pattern>] [--lock-wait <s>] [--dry-run]');
    process.exit(1);
}
