#!/usr/bin/env node
// Rule: line coverage never goes down. Baseline lives in factory-engine/state/apps/<app>/baseline/coverage.json.
//   (no flag)   compare current reports with the baseline
//   --update    raise the baseline to the current values; refuses to lower it (exit 1)
// Reports: backend  build/reports/jacoco/test/jacocoTestReport.xml
//          frontend coverage/**/coverage-summary.json or coverage/**/lcov.info
import fs from 'node:fs';
import path from 'node:path';
import { Report, baselinePath, context, parseArgs, readJson, readText, writeJson } from './lib/core.mjs';

const TOLERANCE = 0.1; // percentage points, absorbs rounding noise only

const args = parseArgs();
const ctx = context(args);
const r = new Report(`coverage ratchet${args.update ? ' (update)' : ''}`);
if (!ctx.appDir) { r.invalid('no app selected'); process.exit(r.finish()); }

function backend() {
  const xml = readText(path.join(ctx.appDir, 'backend/build/reports/jacoco/test/jacocoTestReport.xml'));
  if (xml === null) return null;
  const all = [...xml.matchAll(/<counter type="LINE" missed="(\d+)" covered="(\d+)"\/>/g)];
  if (!all.length) return null;
  const [, missed, covered] = all.at(-1); // report-level counter is the last one
  const total = Number(missed) + Number(covered);
  return total ? (Number(covered) / total) * 100 : 0;
}

function frontend() {
  const dir = path.join(ctx.appDir, 'frontend/coverage');
  const summary = fs.existsSync(dir) ? findDeep(dir, 'coverage-summary.json') : null;
  if (summary) return readJson(summary)?.total?.lines?.pct ?? null;
  const lcov = fs.existsSync(dir) ? findDeep(dir, 'lcov.info') : null;
  if (!lcov) return null;
  let lf = 0, lh = 0;
  for (const m of readText(lcov).matchAll(/^L([FH]):(\d+)/gm)) m[1] === 'F' ? (lf += +m[2]) : (lh += +m[2]);
  return lf ? (lh / lf) * 100 : 0;
}

function findDeep(dir, name) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name === name) return p;
    if (e.isDirectory()) { const f = findDeep(p, name); if (f) return f; }
  }
  return null;
}

const current = { backend: backend(), frontend: frontend() };
const basePath = args['baseline'] || baselinePath(ctx.app || 'fixture');
const base = readJson(basePath, {});
const next = { ...base };
let lowered = false;

for (const layer of ['backend', 'frontend']) {
  const cur = current[layer];
  if (cur === null) { r.missing(`${layer} coverage report not found — run verify (it builds the reports)`); continue; }
  const b = base[layer];
  const fmt = (x) => `${x.toFixed(1)}%`;
  if (b === undefined) r.pass(`${layer} ${fmt(cur)} (no baseline yet)`);
  else if (cur + TOLERANCE < b) { r.invalid(`${layer} ${fmt(cur)} < baseline ${fmt(b)} — add tests, never lower the baseline`); lowered = true; }
  else r.pass(`${layer} ${fmt(cur)} ≥ baseline ${fmt(b)}`);
  if (b === undefined || cur > b) next[layer] = Math.round(cur * 10) / 10;
}

if (args.update) {
  if (lowered) r.invalid('update refused: the ratchet only tightens');
  else if (!r.bad) { writeJson(basePath, { ...next, updatedAt: new Date().toISOString() }); r.pass(`baseline now ${JSON.stringify({ backend: next.backend, frontend: next.frontend })}`); }
}
process.exit(r.finish());
