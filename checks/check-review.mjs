#!/usr/bin/env node
// Rule: a review ran and is clean — 0 findings with severity high|medium still "open".
//   --slice <s>   docs/<phase>/04_build/<s>/review-findings.json
//   --release     docs/<phase>/05_release/review-findings.json
//   (none)        every DONE slice of the current phase
import path from 'node:path';
import { Report, context, parseArgs, readJson, exists } from './lib/core.mjs';

const args = parseArgs();
const ctx = context(args);
const r = new Report('review evidence');
if (!ctx.phaseDir) { r.invalid('no app/phase selected'); process.exit(r.finish()); }

function judge(file, label, report) {
  if (!exists(file)) return report.missing(`${label}: review-findings.json not found`);
  const j = readJson(file);
  if (!j || !Array.isArray(j.findings)) return report.invalid(`${label}: review-findings.json is not valid ({ findings: [] } expected)`);
  const bad = j.findings.filter((f) => !['high', 'medium', 'low'].includes(f.severity) || !['open', 'fixed', 'wontfix'].includes(f.status));
  if (bad.length) return report.invalid(`${label}: ${bad.length} finding(s) with unknown severity/status`);
  const open = j.findings.filter((f) => f.status === 'open' && f.severity !== 'low');
  if (open.length) return report.invalid(`${label}: ${open.length} open high/medium finding(s): ${open.map((f) => f.id).join(', ')}`);
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
