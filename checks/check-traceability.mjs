#!/usr/bin/env node
// Rule: every FR (all phases) has at least one test tagged "@trace FR-x"; no tag points at an unknown FR.
//   --scope built  (default) FRs of previous phases + FRs of current-phase slices that are DONE or the current slice
//   --scope all    every FR; FRs of BLOCKED slices are reported as BLOCKED (not a failure — shown openly)
//   --slice <s>    only the FRs of that slice (used by the red check)
import { Report, context, parseArgs } from './lib/core.mjs';
import { allRequirements, collectTraces, frsOf, parsePlan } from './lib/docs.mjs';

const args = parseArgs();
const ctx = context(args);
const r = new Report(`traceability (${args.slice ? `slice ${args.slice}` : `scope ${args.scope || 'built'}`})`);

if (!ctx.appDir) { r.invalid('no app selected'); process.exit(r.finish()); }

const frs = frsOf(allRequirements(ctx.appDir));
const traces = collectTraces(ctx.appDir);
const plan = ctx.phaseDir ? parsePlan(ctx.phaseDir) || [] : [];
const sliceOf = Object.fromEntries(plan.flatMap((s) => s.frs.map((f) => [f, s.slice])));
const slices = ctx.state?.slices || {};

let wanted;
if (args.slice) {
  const s = plan.find((p) => p.slice === args.slice);
  if (!s) { r.invalid(`slice ${args.slice} not in plan`); process.exit(r.finish()); }
  wanted = frs.filter((f) => s.frs.includes(f.id));
} else if (args.scope === 'all') {
  wanted = frs;
} else {
  wanted = frs.filter((f) => f.phase !== ctx.phase || ['DONE'].includes(slices[sliceOf[f.id]]) || sliceOf[f.id] === ctx.state?.slice);
}

if (!frs.length) r.skip('no requirements yet');
for (const f of wanted) {
  const t = traces.get(f.id) || [];
  if (f.phase === ctx.phase && slices[sliceOf[f.id]] === 'BLOCKED') { r.blocked(`${f.id} slice ${sliceOf[f.id]} is BLOCKED — not delivered`); continue; }
  if (t.length) r.pass(`${f.id} → ${t.map((x) => x.rel).join(', ')}`);
  else r.missing(`${f.id} has no test tagged "@trace ${f.id}"`);
}
const known = new Set(frs.map((f) => f.id));
for (const [id, files] of traces) if (!known.has(id)) r.invalid(`@trace ${id} in ${files[0].rel} — no such requirement`);
if (!args.slice && args.scope !== 'all' && frs.length > wanted.length) r.skip(`${frs.length - wanted.length} FR(s) belong to slices not built yet`);

process.exit(r.finish());
