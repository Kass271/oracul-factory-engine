#!/usr/bin/env node
// Rule: a review ran and is clean — no open finding blocks: severity high (any kind) or medium with kind "defect"
// (a missing kind counts as defect). Open medium "hardening" findings (strengthen a test of behaviour an existing
// passing test already covers) do not block; they are listed and collected in state/apps/<app>/hardening.json for the
// release review and the final report.
//   --slice <s>   docs/<phase>/04_build/<s>/review-findings.json
//   --release     docs/<phase>/05_release/review-findings.json
//   (none)        every DONE slice of the current phase
import path from 'node:path';
import { Report, STATE_DIR, context, parseArgs, readJson, exists, writeJson } from './lib/core.mjs';
const hardeningPath = (app) => path.join(STATE_DIR, 'apps', app, 'hardening.json');

const args = parseArgs();
const ctx = context(args);
const r = new Report('review evidence');
if (!ctx.phaseDir) { r.invalid('no app/phase selected'); process.exit(r.finish()); }

function judge(file, label, report) {
  if (!exists(file)) return report.missing(`${label}: review-findings.json not found`);
  const j = readJson(file);
  if (!j || !Array.isArray(j.findings)) return report.invalid(`${label}: review-findings.json is not valid ({ findings: [] } expected)`);
  const bad = j.findings.filter((f) => !['high', 'medium', 'low'].includes(f.severity) || !['open', 'fixed', 'wontfix'].includes(f.status) || (f.kind !== undefined && !['defect', 'hardening'].includes(f.kind)));
  if (bad.length) return report.invalid(`${label}: ${bad.length} finding(s) with unknown severity/status/kind`);
  const open = j.findings.filter((f) => f.status === 'open' && (f.severity === 'high' || (f.severity === 'medium' && f.kind !== 'hardening')));
  const hardening = j.findings.filter((f) => f.status === 'open' && f.severity === 'medium' && f.kind === 'hardening');
  if (ctx.app) {
    const h = readJson(hardeningPath(ctx.app), {});
    h[label] = hardening.map((f) => ({ id: f.id, file: f.file, problem: f.problem }));
    if (!h[label].length) delete h[label];
    try { writeJson(hardeningPath(ctx.app), h); } catch { /* informational */ }
  }
  for (const f of hardening) report.warn(`${label}: hardening ${f.id} open (${f.file}) — not blocking; goes to the release review`);
  if (open.length) return report.invalid(`${label}: ${open.length} open blocking finding(s) (high, or medium defect): ${open.map((f) => f.id).join(', ')}`);
  const low = j.findings.filter((f) => f.status === 'open').length;
  report.pass(`${label}: clean (round ${j.round ?? '?'}, ${j.findings.length} finding(s), ${low} open low)`);
}

if (args.release) judge(path.join(ctx.phaseDir, '05_release', 'review-findings.json'), 'release', r);
else {
  const slices = args.slice ? [args.slice] : Object.entries(ctx.state?.slices || {}).filter(([, v]) => v === 'DONE').map(([k]) => k);
  if (!slices.length) r.skip('no finished slices yet');
  for (const s of slices) judge(path.join(ctx.phaseDir, '04_build', s, 'review-findings.json'), `slice ${s}`, r);
}
process.exit(r.finish());
