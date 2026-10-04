#!/usr/bin/env node
// Full smoke test of the factory pipeline with REAL tools (Spring Initializr, Gradle, Angular CLI, Docker, Playwright).
// The agents' work is replaced by a canned "todo" app (self-test/smoke-app) so the run is deterministic; every gate,
// check, hook decision and state transition is the real one. Runs in a sandbox (own apps + state dir), never in ../apps.
//   node self-test/smoke.mjs [--keep-running] [--dir <sandbox>]
// Exit 0 only if every step behaves as expected (including the gates that MUST say no).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ENGINE, parseArgs } from '../checks/lib/core.mjs';

const args = parseArgs();
const SMOKE = path.join(ENGINE, 'self-test', 'smoke-app');
const root = path.resolve(args.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'oracul-smoke-')));
fs.mkdirSync(root, { recursive: true });
const APP = 'smoke-todo';
const appDir = path.join(root, 'apps', APP);
const env = { ...process.env, FACTORY_APPS_DIR: path.join(root, 'apps'), FACTORY_STATE_DIR: path.join(root, 'state') };
const PHASE = 'phase-01_mvp';
const docs = (step) => path.join(appDir, 'docs', PHASE, step);
const log = [];

function sh(script, a = [], opts = {}) {
  const r = spawnSync('node', [path.join(ENGINE, script), ...a], { env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, cwd: root, ...opts });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') + (r.error ? String(r.error) : '') };
}
const hook = (name, event) => sh(`hooks/${name}.mjs`, [], { input: JSON.stringify({ cwd: root, ...event }) });
const copy = (from, to) => fs.cpSync(from, to, { recursive: true });

function step(name, expect, fn) {
  const t0 = Date.now();
  process.stdout.write(`▶ ${name} … `);
  let r;
  try { r = fn(); } catch (e) { r = { code: 'ERR', out: String(e.stack || e) }; }
  const ok = r.code === expect;
  const secs = Math.round((Date.now() - t0) / 1000);
  log.push({ name, ok, expect, got: r.code, secs });
  console.log(`${ok ? 'PASS' : 'FAIL'} (exit ${r.code}, expected ${expect}, ${secs}s)`);
  if (!ok) {
    console.log(r.out.split('\n').slice(-80).map((l) => `   | ${l}`).join('\n'));
    finish(1);
  }
  return r;
}

function finish(code) {
  if (!args['keep-running'] && fs.existsSync(path.join(appDir, 'docker-compose.yml'))) sh('bin/stack.mjs', ['down']);
  const total = log.reduce((s, l) => s + l.secs, 0);
  console.log(`\n${log.filter((l) => l.ok).length}/${log.length} smoke steps passed in ${Math.round(total / 60)} min — sandbox: ${root}`);
  console.log(code ? '❌ SMOKE RED' : '✅ SMOKE GREEN');
  process.exit(code);
}

console.log(`Oracul smoke test — sandbox ${root}\n`);

// ---------------------------------------------------------------- Step 0
step('env-check (Docker, JDK, Node, network)', 0, () => sh('bin/env-check.mjs'));
step('state init + phase new', 0, () => {
  const a = sh('bin/state.mjs', ['init', APP, '--title', 'Smoke Todo']);
  return a.code ? a : sh('bin/state.mjs', ['phase', 'new', 'mvp']);
});
step('env-check --write', 0, () => sh('bin/env-check.mjs', ['--write']));
step('scaffold (Initializr + Angular + Material + Playwright)', 0, () => sh('bin/scaffold.mjs'));
step('Step 0 artifacts', 0, () => sh('checks/check-artifacts.mjs', ['--step', '00_setup']));
step('Step 0 verify on the skeleton (Gradle + Testcontainers + Vitest)', 0, () => sh('checks/verify.mjs'));
step('a fresh scaffold needs no migration (templates = migration target)', 0, () => sh('bin/migrate.mjs', ['--check']));
step('commit skeleton', 0, () => sh('bin/commit.mjs', ['--message', `${PHASE} 00_setup: skeleton`]));

// ---------------------------------------------------------------- Step 1
sh('bin/state.mjs', ['set', 'step', '01_scope']);
copy(path.join(SMOKE, 'docs', '01_scope'), docs('01_scope'));
step('Step 1 gate says NO before the user approves', 1, () => sh('checks/check-artifacts.mjs', ['--step', '01_scope']));
step('stop hook never blocks the dialog step', 0, () => hook('stop', { stop_hook_active: false }));
step('user approves scope → gate green', 0, () => {
  const a = sh('bin/state.mjs', ['approve', 'scope']);
  return a.code ? a : sh('checks/check-artifacts.mjs', ['--step', '01_scope']);
});

// ---------------------------------------------------------------- Step 2
sh('bin/state.mjs', ['set', 'step', '02_specs']);
copy(path.join(SMOKE, 'docs', '02_specs'), docs('02_specs'));
copy(path.join(SMOKE, 'contract'), appDir);
step('Step 2 specs cover every FR + contract valid', 0, () => {
  const a = sh('checks/check-artifacts.mjs', ['--step', '02_specs']);
  return a.code ? a : sh('checks/check-contract.mjs');
});

// ---------------------------------------------------------------- Step 3
sh('bin/state.mjs', ['set', 'step', '03_plan']);
copy(path.join(SMOKE, 'docs', '03_plan'), docs('03_plan'));
step('Step 3 gate says NO before the user approves', 1, () => sh('checks/check-artifacts.mjs', ['--step', '03_plan']));
step('user approves plan → slices loaded → gate green', 0, () => {
  for (const a of [['approve', 'plan'], ['slices-from-plan']]) { const r = sh('bin/state.mjs', a); if (r.code) return r; }
  const n = sh('bin/state.mjs', ['next-slice']);
  if (n.out.trim() !== '01_todos') return { code: 1, out: `next-slice: ${n.out}` };
  return sh('checks/check-artifacts.mjs', ['--step', '03_plan']);
});
sh('bin/commit.mjs', ['--message', `${PHASE} 01-03: scope, specs, plan approved`]);

// ---------------------------------------------------------------- Step 4 — slice 01_todos
sh('bin/state.mjs', ['set', 'step', '04_build']);
for (const a of [['set', 'slice', '01_todos'], ['slice', '01_todos', 'IN_PROGRESS'], ['set', 'subStep', 'red']]) sh('bin/state.mjs', a);
const W = (rel) => ({ tool_name: 'Write', tool_input: { file_path: path.join(appDir, rel), content: 'x' } });
step('RED: guard blocks production code', 2, () => hook('guard-edits', W('backend/src/main/java/com/oracul/app/todos/TodosController.java')));
step('RED: guard allows writing tests', 0, () => hook('guard-edits', W('backend/src/test/java/com/oracul/app/todos/TodosApiIT.java')));
copy(path.join(SMOKE, 'red'), appDir);
step('RED: red-check proves tests fail for the right reason', 0, () => sh('bin/red-check.mjs', ['--slice', '01_todos']));
step('RED: red-check --scope slice runs only the related tests and agrees', 0, () => {
  const r = sh('bin/red-check.mjs', ['--slice', '01_todos', '--scope', 'slice']);
  return r.code === 0 && /\(related\) took/.test(r.out) && /^Scope: slice/m.test(fs.readFileSync(path.join(docs('04_build'), '01_todos', 'red-evidence.md'), 'utf8')) ? r : { code: r.code || 1, out: r.out };
});

sh('bin/state.mjs', ['set', 'subStep', 'green']);
sh('bin/state.mjs', ['round', '+1']);
step('GREEN: guard blocks editing a test', 2, () => hook('guard-edits', W('frontend/src/app/todos/todos.spec.ts')));
step('GREEN: guard blocks editing the contract', 2, () => hook('guard-edits', W('api/openapi.yaml')));
step('stop hook blocks while verify is stale', 2, () => hook('stop', { stop_hook_active: false }));
copy(path.join(SMOKE, 'green'), appDir);
step('GREEN: verify (backend + frontend + all checks)', 0, () => sh('checks/verify.mjs'));
// A test that fails on its first attempt and passes on the retry (Gradle test-retry): verify stays GREEN and says FLAKY.
step('FLAKY: a test that passes only on the retry → verify GREEN + FLAKY line + flaky.json', 0, () => {
  const t = path.join(appDir, 'backend/src/test/java/com/oracul/app/FlakyOnceTest.java');
  fs.writeFileSync(t, `package com.oracul.app;

import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.fail;

class FlakyOnceTest {
  @Test void failsOnlyOnTheFirstAttempt() throws Exception {
    Path marker = Path.of("build", "oracul-flaky-once.marker");
    if (!Files.exists(marker)) { Files.createDirectories(marker.getParent()); Files.createFile(marker); fail("first attempt"); }
  }
}
`);
  const v = sh('checks/verify.mjs');
  fs.rmSync(t, { force: true });
  fs.rmSync(path.join(appDir, 'backend/build/oracul-flaky-once.marker'), { force: true });
  const flaky = JSON.parse(fs.readFileSync(path.join(root, 'state', 'apps', APP, 'flaky.json'), 'utf8'));
  const ok = v.code === 0 && /FLAKY\s+com\.oracul\.app\.FlakyOnceTest\.failsOnlyOnTheFirstAttempt/.test(v.out) && Object.keys(flaky.tests).some((k) => /FlakyOnceTest/.test(k));
  return ok ? v : { code: 1, out: v.out };
});
step('GREEN: verify again without the flaky test (clean reports for the close)', 0, () => sh('checks/verify.mjs'));

sh('bin/state.mjs', ['set', 'subStep', 'review']);
step('REVIEW: reviewer may not touch code', 2, () => hook('guard-edits', W('backend/src/main/java/com/oracul/app/todos/TodoEntity.java')));
step('REVIEW: subagent-stop blocks a reviewer without findings file', 2, () => hook('subagent-stop', { agent_type: 'oracul:reviewer' }));
copy(path.join(SMOKE, 'review', 'review-findings.json'), path.join(docs('04_build'), '01_todos', 'review-findings.json'));
step('REVIEW: findings clean', 0, () => sh('checks/check-review.mjs', ['--slice', '01_todos']));
// A partial test run after the round's verify (as a reviewer might do) rewrites the JaCoCo report and JUnit XML from
// one class. The close must notice it and re-verify instead of reading a false coverage drop.
step('REVIEW: a partial backend test run after verify (one test class)', 0, () => {
  const x = spawnSync('./gradlew', ['test', '--tests', 'com.oracul.app.todos.TodosApiIT', '--console=plain', '-q'], { cwd: path.join(appDir, 'backend'), env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { code: x.status, out: (x.stdout || '') + (x.stderr || '') };
});
step('slice close as the workflow runs it: verify --reuse-if-fresh → FULL run → artifacts → coverage --update → commit → DONE', 0, () => {
  const v = sh('checks/verify.mjs', ['--reuse-if-fresh']);
  if (v.code || !/running a full verify/.test(v.out)) return { code: v.code || 1, out: `expected a full re-verify:\n${v.out}` };
  for (const [s, a] of [
    ['checks/check-artifacts.mjs', ['--step', '04_build', '--slice', '01_todos', '--stage', 'done']],
    ['checks/check-coverage.mjs', ['--update']],
    ['bin/commit.mjs', ['--message', `${PHASE} 01_todos: done (FR-1, FR-2)`]],
    ['bin/state.mjs', ['slice', '01_todos', 'DONE']],
    ['bin/state.mjs', ['set', 'subStep', 'none']],
  ]) { const r = sh(s, a); if (r.code) return r; }
  return sh('checks/check-artifacts.mjs', ['--step', '04_build']);
});
step('a second close-time verify with nothing changed reuses the full verify (no extra time)', 0, () => {
  const v = sh('checks/verify.mjs', ['--reuse-if-fresh']);
  return /verify: reusing the full GREEN verify/.test(v.out) ? v : { code: 1, out: v.out };
});

// ---------------------------------------------------------------- Step 5
for (const a of [['set', 'step', '05_release'], ['set', 'slice', 'none']]) sh('bin/state.mjs', a);
step('release verify --scope all', 0, () => sh('checks/verify.mjs', ['--scope', 'all']));
copy(path.join(SMOKE, 'release', 'review-findings.json'), path.join(docs('05_release'), 'review-findings.json'));
step('release review clean', 0, () => sh('checks/check-review.mjs', ['--release']));
// Official E2E exactly as the workflows run it: subStep e2e, up, Playwright in a detached worker, e2e-wait until done.
const STACK = path.join(ENGINE, 'bin', 'stack.mjs');
const bashHook = (command) => hook('guard-edits', { tool_name: 'Bash', tool_input: { command } });
step('E2E: guard allows up / detach / wait in subStep e2e', 0, () => {
  sh('bin/state.mjs', ['set', 'subStep', 'e2e']);
  for (const c of ['up', 'e2e --detach', 'e2e-wait --max 480']) { const r = bashHook(`node "${STACK}" ${c}`); if (r.code) return r; }
  return { code: 0, out: '' };
});
step('E2E: Docker stack up (own call, under the lock)', 0, () => sh('bin/stack.mjs', ['up']));
step('Docker: a second up after only a test change does not rebuild the images', 0, () => {
  fs.appendFileSync(path.join(appDir, 'backend/src/test/java/com/oracul/app/todos/TodosApiIT.java'), '\n// smoke: test-only change\n');
  const r = sh('bin/stack.mjs', ['up']);
  return r.code === 0 && /images current — no rebuild/.test(r.out) ? r : { code: r.code || 1, out: r.out };
});
step('E2E: Playwright starts in a detached worker', 0, () => sh('bin/stack.mjs', ['e2e', '--detach']));
step('E2E: e2e-wait until done (75 = still running) — PASS with screenshot evidence', 0, () => {
  let r;
  for (let i = 0; i < 8; i++) { r = sh('bin/stack.mjs', ['e2e-wait', '--max', '480']); if (r.code !== 75) break; }
  return r.code === 0 && /E2E PASS/.test(r.out) ? r : { code: r.code || 1, out: r.out };
});
step('E2E: stack lock released after the detached run', 0, () => ({ code: fs.existsSync(path.join(root, 'state', 'apps', APP, 'stack.lock')) ? 1 : 0, out: 'stack.lock still present' }));
step('E2E: the full run is recorded and covers exactly this code (check-e2e-fresh)', 0, () => sh('checks/check-e2e-fresh.mjs'));
step('E2E: focus run of the slice (related specs only) — official report untouched', 0, () => {
  const official = path.join(appDir, 'e2e', 'report', 'results.json');
  const before = fs.readFileSync(official, 'utf8');
  const r = sh('bin/stack.mjs', ['e2e', '--focus-slice', '01_todos', '--no-up']);
  const ok = r.code === 0 && /FOCUS 01_todos: /.test(r.out) && /FOCUS E2E PASS/.test(r.out) && fs.readFileSync(official, 'utf8') === before
    && fs.existsSync(path.join(appDir, 'e2e', 'report-focus', 'results.json'));
  return ok ? r : { code: 1, out: r.out };
});
step('E2E: a production change makes the full run stale (check-e2e-fresh says no)', 1, () => {
  const f = path.join(appDir, 'backend/src/main/resources/application.properties');
  const orig = fs.readFileSync(f, 'utf8');
  fs.appendFileSync(f, '\n# smoke\n');
  const r = sh('checks/check-e2e-fresh.mjs');
  fs.writeFileSync(f, orig);
  return r;
});
step('gate sentinel in real bash: last line is ORACUL_EXIT=<status of the chain>', 0, () => {
  const cmd = `node "${path.join(ENGINE, 'checks', 'check-review.mjs')}" --release && git -C "${appDir}" status --short >/dev/null\necho "ORACUL_EXIT=$?"`;
  const x = spawnSync('bash', ['-c', cmd], { env, cwd: root, encoding: 'utf8' });
  return { code: /ORACUL_EXIT=0\s*$/.test(x.stdout) ? 0 : 1, out: x.stdout + x.stderr };
});
step('scratch run (test-fix): scoped by spec file, official report untouched', 0, () => {
  sh('bin/state.mjs', ['set', 'subStep', 'test-fix']);
  const allowed = bashHook(`node "${STACK}" e2e --scratch --grep todos.spec.ts`);
  if (allowed.code) return allowed;
  const official = path.join(appDir, 'e2e', 'report', 'results.json');
  const before = fs.readFileSync(official, 'utf8');
  const r = sh('bin/stack.mjs', ['e2e', '--scratch', '--grep', 'todos.spec.ts', '--no-up']);
  const scratch = JSON.parse(fs.readFileSync(path.join(appDir, 'e2e', 'report-scratch', 'results.json'), 'utf8'));
  const ok = r.code === 0 && fs.readFileSync(official, 'utf8') === before && scratch.stats?.expected > 0;
  sh('bin/state.mjs', ['set', 'subStep', 'none']);
  return ok ? r : { code: 1, out: `${r.out}\nscratch stats ${JSON.stringify(scratch.stats)} · official changed: ${fs.readFileSync(official, 'utf8') !== before}` };
});
step('gen-traceability: every FR ✔', 0, () => sh('checks/gen-traceability.mjs'));
step('Step 5 gate says NO before the QA pack exists', 1, () => sh('checks/check-artifacts.mjs', ['--step', '05_release']));
copy(path.join(SMOKE, 'release', 'qa'), path.join(docs('05_release'), 'qa'));
step('Step 5 artifacts (QA pack, screenshots, E2E report, traceability)', 0, () => sh('checks/check-artifacts.mjs', ['--step', '05_release']));
step('final verify (quick) + stop hook lets the session end', 0, () => {
  const v = sh('checks/verify.mjs', ['--quick', '--scope', 'all']);
  return v.code ? v : hook('stop', { stop_hook_active: false });
});
step('release commit', 0, () => sh('bin/commit.mjs', ['--message', `${PHASE} 05_release: GREEN`]));
console.log('\n' + fs.readFileSync(path.join(docs('05_release'), 'qa', 'traceability.md'), 'utf8'));
finish(0);
