// Input groups and the gate ledger — "green stays green" (round 4).
// Every app file belongs to one explicit group; anything not listed is SHARED and therefore an input of every gate
// (fail-safe: an unknown file can only cause a re-run, never a skipped gate).
//   backend   backend/**                         (minus build output)
//   frontend  frontend/**                        (minus build output and the generated client)
//   e2e       e2e/**                             (minus reports)
//   docs      docs/**, **/*.md
//   shared    everything else: api/, compose files, .oracul/, .dockerignore, root files, unknown files
// Gates and their inputs:
//   backend     backend + shared + docs a backend test names        frontend   frontend + shared + docs a spec names
//   e2e:<spec>  image inputs + e2e helpers/config + that spec       docs       docs
// The ledger state/apps/<app>/gates.json: { gates: { <gate>: { hash, result: pass|fail, full, at } } } — written only by
// the gate commands (a full verify, an official E2E run); related/focus runs never write full: true.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR, readJson, writeJson } from './core.mjs';
import { imageExcluded } from './hash.mjs';

const SKIP_DIRS = new Set(['.git', 'node_modules', '.angular', '.gradle', 'build', 'dist', 'coverage', 'target', '.idea', '.vscode']);
const NOT_INPUT = [/^frontend\/src\/app\/api\//, /^e2e\/(report|test-results)[^/]*\//, /^e2e\/playwright-report\//, /(^|\/)\.DS_Store$/];

export function groupOf(rel) {
  if (NOT_INPUT.some((re) => re.test(rel))) return null;
  if (/^docs\//.test(rel) || /\.md$/i.test(rel)) return 'docs';
  if (/^backend\//.test(rel)) return 'backend';
  if (/^frontend\//.test(rel)) return 'frontend';
  if (/^e2e\//.test(rel)) return 'e2e';
  return 'shared';
}

export function appFiles(appDir, rel = '') {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(path.join(appDir, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) out.push(...appFiles(appDir, r)); }
    else if (e.isFile()) out.push(r);
  }
  return out;
}

export function filesByGroup(appDir) {
  const g = { backend: [], frontend: [], e2e: [], docs: [], shared: [] };
  for (const r of appFiles(appDir)) { const k = groupOf(r); if (k) g[k].push(r); }
  return g;
}

const isTestOf = { backend: (r) => /^backend\/src\/test\//.test(r), frontend: (r) => /\.spec\.ts$/.test(r) && r.startsWith('frontend/'), e2e: (r) => /^e2e\/.*\.(spec|test)\.ts$/.test(r) };
// Doc files (by file name) that a layer's tests name — e.g. a README test reading ../README.md (G8).
export function docsNamedBy(appDir, layer, groups = filesByGroup(appDir)) {
  const tests = groups[layer]?.filter(isTestOf[layer]) || [];
  const text = tests.map((t) => { try { return fs.readFileSync(path.join(appDir, t), 'utf8'); } catch { return ''; } }).join('\n');
  return groups.docs.filter((d) => text.includes(path.basename(d)));
}

function hashFiles(appDir, list) {
  const h = crypto.createHash('sha256');
  for (const r of [...new Set(list)].sort()) { h.update(r); h.update('\0'); try { h.update(fs.readFileSync(path.join(appDir, r))); } catch { h.update('<missing>'); } h.update('\0'); }
  return h.digest('hex').slice(0, 32);
}

export const specFiles = (groups) => groups.e2e.filter((r) => /^e2e\/tests\/.+\.(spec|test)\.ts$/.test(r)).map((r) => r.slice('e2e/tests/'.length)).sort();

// The input hash of one gate ('backend' | 'frontend' | 'docs' | 'e2e:<spec relative to e2e/tests>').
export function gateHash(appDir, gate, groups = filesByGroup(appDir)) {
  if (gate === 'backend' || gate === 'frontend') return hashFiles(appDir, [...groups[gate], ...groups.shared, ...docsNamedBy(appDir, gate, groups)]);
  if (gate === 'docs') return hashFiles(appDir, groups.docs);
  if (gate.startsWith('e2e:')) {
    const spec = `e2e/tests/${gate.slice(4)}`;
    const ex = imageExcluded(appDir);
    const image = appFiles(appDir).filter((r) => groupOf(r) && !ex(r));
    const helpers = groups.e2e.filter((r) => !isTestOf.e2e(r));
    let specText = '';
    try { specText = fs.readFileSync(path.join(appDir, spec), 'utf8'); } catch { /* deleted spec */ }
    const docs = groups.docs.filter((d) => specText.includes(path.basename(d))); // a spec that reads a doc (README)
    return hashFiles(appDir, [...image, ...helpers, spec, ...docs]);
  }
  throw new Error(`unknown gate ${gate}`);
}

// ---- ledger
export const ledgerPath = (app) => path.join(STATE_DIR, 'apps', app, 'gates.json');
export const readLedger = (app) => readJson(ledgerPath(app), { gates: {} });
export function recordGates(app, entries) {
  const l = readLedger(app);
  l.gates ||= {};
  const at = new Date().toISOString();
  for (const [name, e] of Object.entries(entries)) l.gates[name] = { ...e, at };
  try { writeJson(ledgerPath(app), l); } catch { /* the gate result itself is what counts */ }
  return l;
}
// green (current) · stale (green on other inputs) · red · never
export function gateState(appDir, app, gate, groups) {
  const e = readLedger(app).gates?.[gate];
  if (!e) return { state: 'never' };
  if (e.result !== 'pass') return { state: 'red', at: e.at };
  if (gate !== 'docs' && !gate.startsWith('e2e:') && !e.full) return { state: 'stale', at: e.at, why: 'not a full run' };
  return e.hash === gateHash(appDir, gate, groups) ? { state: 'green', at: e.at } : { state: 'stale', at: e.at, why: 'inputs changed' };
}
// Every gate of the app: backend, frontend, every E2E spec on disk.
export function allGates(appDir) {
  const groups = filesByGroup(appDir);
  return { groups, gates: ['backend', 'frontend', ...specFiles(groups).map((s) => `e2e:${s}`)] };
}
