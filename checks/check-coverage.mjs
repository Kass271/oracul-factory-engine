#!/usr/bin/env node
// Rule: line coverage never goes down. Baseline lives in factory-engine/state/apps/<app>/baseline/coverage.json.
//   (no flag)   compare current reports with the baseline
//   --update    raise the baseline to the current values; refuses to lower it (exit 1)
// Reports: backend  build/reports/jacoco/test/jacocoTestReport.xml
//          frontend coverage/**/coverage-summary.json or coverage/**/lcov.info
import { Report, baselinePath, context, parseArgs, readJson, writeJson } from './lib/core.mjs';
import { coverageOf } from './lib/coverage.mjs';
import { gateState, readLedger } from './lib/inputs.mjs';

const TOLERANCE = 0.1; // percentage points, absorbs rounding noise only

const args = parseArgs();
const ctx = context(args);
const r = new Report(`coverage ratchet${args.update ? ' (update)' : ''}`);
if (!ctx.appDir) { r.invalid('no app selected'); process.exit(r.finish()); }

// A layer whose gate is green on the CURRENT inputs uses the coverage of that full run (a related run since then may have
// rewritten the report from a subset); otherwise the report on disk.
const current = {};
const fromLedger = {};
for (const layer of ['backend', 'frontend']) {
  const e = ctx.app ? readLedger(ctx.app).gates?.[layer] : null;
  if (e && typeof e.coverage === 'number' && gateState(ctx.appDir, ctx.app, layer).state === 'green') { current[layer] = e.coverage; fromLedger[layer] = e.at; }
  else current[layer] = coverageOf(ctx.appDir, layer);
}
const basePath = args['baseline'] || baselinePath(ctx.app || 'fixture');
const base = readJson(basePath, {});
const next = { ...base };
let lowered = false;

for (const layer of ['backend', 'frontend']) {
  const cur = current[layer];
  if (cur === null) { r.missing(`${layer} coverage report not found — run verify (it builds the reports)`); continue; }
  const b = base[layer];
  const fmt = (x) => `${x.toFixed(1)}%`;
  const src = fromLedger[layer] ? ` (full run of ${fromLedger[layer]}, inputs unchanged)` : '';
  if (b === undefined) r.pass(`${layer} ${fmt(cur)}${src} (no baseline yet)`);
  else if (cur + TOLERANCE < b) { r.invalid(`${layer} ${fmt(cur)} < baseline ${fmt(b)} — add tests, never lower the baseline`); lowered = true; }
  else r.pass(`${layer} ${fmt(cur)}${src} ≥ baseline ${fmt(b)}`);
  if (b === undefined || cur > b) next[layer] = Math.round(cur * 10) / 10;
}

if (args.update) {
  if (lowered) r.invalid('update refused: the ratchet only tightens');
  else if (!r.bad) { writeJson(basePath, { ...next, updatedAt: new Date().toISOString() }); r.pass(`baseline now ${JSON.stringify({ backend: next.backend, frontend: next.frontend })}`); }
}
process.exit(r.finish());
