#!/usr/bin/env node
// Docker stack of the active app.
//   up      docker compose up -d --build, then wait until backend health and frontend answer
//   down    docker compose down
//   status  docker compose ps
//   e2e     up (unless --no-up) + Playwright; screenshots → docs/<phase>/05_release/qa/screenshots
import path from 'node:path';
import { context, parseArgs, run, tail } from '../checks/lib/core.mjs';

const args = parseArgs();
const ctx = context(args);
const cmd = args._[0];
if (!ctx.appDir) { console.error('stack: no active app'); process.exit(1); }
const URLS = { frontend: 'http://localhost:4200', backend: 'http://localhost:8080/actuator/health' };

function compose(...a) {
  const r = run('docker', ['compose', ...a], { cwd: ctx.appDir });
  if (r.code) { console.error(tail(r.out, 80)); process.exit(r.code); }
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

switch (cmd) {
  case 'up': await up(); break;
  case 'down': compose('down'); console.log('down'); break;
  case 'status': console.log(compose('ps')); break;
  case 'e2e': {
    if (!args['no-up']) await up();
    const shots = path.join(ctx.phaseDir, '05_release', 'qa', 'screenshots');
    const r = run('npx', ['playwright', 'test'], { cwd: path.join(ctx.appDir, 'e2e'), env: { ...process.env, QA_SCREENSHOTS_DIR: shots, CI: 'true' } });
    console.log(tail(r.out, 60));
    console.log(r.code ? 'E2E FAIL' : 'E2E PASS');
    process.exit(r.code);
  }
  default:
    console.error('usage: stack.mjs up|down|status|e2e [--no-up]');
    process.exit(1);
}
