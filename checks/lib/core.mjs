// Shared helpers for every Oracul script: paths, state, args, reporting, file walking.
// Node built-ins only — the engine must run with nothing installed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const ENGINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const ROOT = path.resolve(ENGINE, '..');
export const APPS_DIR = process.env.FACTORY_APPS_DIR || path.join(ROOT, 'apps');
export const STATE_DIR = process.env.FACTORY_STATE_DIR || path.join(ENGINE, 'state');

export const STEPS = ['00_setup', '01_scope', '02_specs', '03_plan', '04_build', '05_release'];
export const SUBSTEPS = ['none', 'spec', 'sync', 'red', 'test-fix', 'green', 'e2e', 'review', 'qa'];
export const SLICE_STATUS = ['PENDING', 'IN_PROGRESS', 'DONE', 'BLOCKED'];

// ---------- args ----------
export function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) out[k] = v;
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) out[k] = argv[++i];
      else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

// ---------- json / fs ----------
export const readJson = (p, fallback = null) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
};
export const writeJson = (p, data) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
};
export const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
export const exists = (p) => fs.existsSync(p);
export const today = () => new Date().toISOString().slice(0, 10);

const SKIP_DIRS = new Set(['node_modules', '.git', '.gradle', '.angular', 'build', 'dist', 'target', 'coverage', 'report', 'test-results', 'playwright-report']);
export function walk(dir, filter = () => true, acc = []) {
  if (!exists(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p, filter, acc); }
    else if (filter(p)) acc.push(p);
  }
  return acc;
}

// ---------- state ----------
export const activePath = () => path.join(STATE_DIR, 'active-app.json');
export const statePath = (app) => path.join(STATE_DIR, 'apps', app, 'state.json');
export const baselinePath = (app) => path.join(STATE_DIR, 'apps', app, 'baseline', 'coverage.json');
export const lastRunPath = (app) => path.join(STATE_DIR, 'apps', app, 'last-run.json');
export const stackLockPath = (app) => path.join(STATE_DIR, 'apps', app, 'stack.lock');
// Detached E2E run (stack.mjs e2e --detach / e2e-wait): status JSON + log of the background worker.
export const e2eRunPath = (app, ext) => path.join(STATE_DIR, 'apps', app, `e2e-run.${ext}`);
// Runtime records next to state.json (never inside it, so the state format stays unchanged):
export const timingsPath = (app) => path.join(STATE_DIR, 'apps', app, 'timings.jsonl'); // one line per subStep change
export const flakyPath = (app) => path.join(STATE_DIR, 'apps', app, 'flaky.json'); // tests that passed only on retry
export const stackHashPath = (app) => path.join(STATE_DIR, 'apps', app, 'stack-hash.json'); // inputs of the built images
export const e2eLastPath = (app) => path.join(STATE_DIR, 'apps', app, 'e2e-last.json'); // last official full E2E run
export const lastFailuresPath = (app) => path.join(STATE_DIR, 'apps', app, 'last-failures.json'); // failing tests of the last verify
export const notesPath = (app) => path.join(STATE_DIR, 'apps', app, 'notes.jsonl'); // interventions + tagged stops
export const factoryIssuesPath = (app) => path.join(STATE_DIR, 'apps', app, 'factory-issues.jsonl'); // factory backlog
export const DELAY_TAGS = ['scope', 'app-tests', 'factory-false-positive', 'agent-error', 'infra', 'external-service'];
export const gateRunsPath = (app) => path.join(STATE_DIR, 'apps', app, 'gate-runs.jsonl'); // every gate run (retro)
// Append one gate run { gate, exit, seconds, hash? } — informational, never fails the gate.
export function appendGateRun(app, entry) {
  if (!app) return;
  try { fs.mkdirSync(path.dirname(gateRunsPath(app)), { recursive: true }); fs.appendFileSync(gateRunsPath(app), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`); } catch { /* informational */ }
}
export const migrationsPath = (app) => path.join(STATE_DIR, 'apps', app, 'migrations.json'); // applied / refused migrations
// Append a timing record; a logging problem never fails the command that logs.
export function appendTiming(app, entry) {
  try {
    fs.mkdirSync(path.dirname(timingsPath(app)), { recursive: true });
    fs.appendFileSync(timingsPath(app), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  } catch { /* timings are informational */ }
}
// "took 12s" / "took 3m 05s"
export const took = (ms) => { const s = Math.round(ms / 1000); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`; };
export const loadActive = () => readJson(activePath());
export const loadState = (app) => readJson(statePath(app));
export const saveState = (app, s) => writeJson(statePath(app), s);

// Resolve which app/phase a script works on. --app-dir lets self-tests point at fixtures.
export function context(args = {}) {
  const active = loadActive() || {};
  const app = args.app || active.app || null;
  const appDir = args['app-dir'] ? path.resolve(args['app-dir']) : app ? path.join(APPS_DIR, app) : null;
  const state = app ? loadState(app) : null;
  const phase = args.phase || state?.phase || listPhases(appDir).at(-1) || null;
  const phaseDir = appDir && phase ? path.join(appDir, 'docs', phase) : null;
  return { app, appDir, state, phase, phaseDir };
}

export function listPhases(appDir) {
  const d = appDir && path.join(appDir, 'docs');
  if (!d || !exists(d)) return [];
  return fs.readdirSync(d, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^phase-\d\d_/.test(e.name)).map((e) => e.name).sort();
}

// ---------- reporting: PASS / MISSING / INVALID (+ informational WARN / SKIP / BLOCKED) ----------
export class Report {
  constructor(title) { this.title = title; this.lines = []; this.bad = 0; }
  pass(m) { this.lines.push(['PASS', m]); }
  missing(m) { this.lines.push(['MISSING', m]); this.bad++; }
  invalid(m) { this.lines.push(['INVALID', m]); this.bad++; }
  warn(m) { this.lines.push(['WARN', m]); }
  skip(m) { this.lines.push(['SKIP', m]); }
  blocked(m) { this.lines.push(['BLOCKED', m]); }
  finish() {
    console.log(`== ${this.title} ==`);
    for (const [k, m] of this.lines) console.log(`${k.padEnd(8)} ${m}`);
    console.log(this.bad ? `RESULT  FAIL (${this.bad} problem${this.bad > 1 ? 's' : ''})` : 'RESULT  OK');
    return this.bad ? 1 : 0;
  }
}

export function run(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  return { code: r.status ?? 1, out: (r.stdout || '') + (r.stderr || ''), error: r.error };
}

export const tail = (s, n = 60) => s.split('\n').slice(-n).join('\n');
