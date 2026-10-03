#!/usr/bin/env node
// Rule: every artifact the manifest lists for a step exists and follows its content rule.
//   --step <00_setup|01_scope|02_specs|03_plan|04_build|05_release>
//   --slice <s> --stage <spec|red|review|done|blocked>   (04_build) check one slice up to a stage
//   04_build without --slice: every DONE slice (stage done) and BLOCKED slice (stage blocked); stage-spec items
//   (planning lines of the spec delta) are only checked for an explicit --slice
//   --only <text>        only items whose path contains <text> (comma separated)
//   --skip-rule <rule>   ignore items with that rule (e.g. approved, while the user has not approved yet)
// Output per item: PASS / MISSING / INVALID. Exit 1 on any MISSING/INVALID.
import fs from 'node:fs';
import path from 'node:path';
import { ENGINE, Report, STEPS, context, exists, parseArgs, readJson, readText } from './lib/core.mjs';
import { allRequirements, frsOf, hasCycle, isApproved, parsePlan, parseRequirements, parseSpecFrs, parseSpecs, testLayer } from './lib/docs.mjs';

const args = parseArgs();
const ctx = context(args);
const step = args.step;
const r = new Report(`artifacts ${step}${args.slice ? ` / ${args.slice}` : ''}${args.stage ? ` (stage ${args.stage})` : ''}`);
if (!STEPS.includes(step)) { r.invalid(`--step must be one of ${STEPS.join(', ')}`); process.exit(r.finish()); }
if (!ctx.appDir || !ctx.phase) { r.invalid('no app/phase selected'); process.exit(r.finish()); }

const manifest = readJson(args.manifest || path.join(ENGINE, 'checks', 'manifest', 'artifacts.manifest.json'));
const STAGE_ORDER = ['spec', 'red', 'review', 'done'];
const phaseReqs = () => parseRequirements(path.join(ctx.phaseDir, '01_scope', 'requirements.md'), ctx.phase) || [];
const plan = () => parsePlan(ctx.phaseDir) || [];
const blockedFrs = () => {
  const st = ctx.state?.slices || {};
  return new Set(plan().filter((s) => st[s.slice] === 'BLOCKED').flatMap((s) => s.frs));
};

const RULES = {
  nonEmpty: (p) => (readText(p) || '').trim().length > 0 || 'file is empty',
  contains: (p, arg) => (readText(p) || '').includes(arg) || `does not contain "${arg}"`,
  regex: (p, arg) => new RegExp(arg, 'm').test(readText(p) || '') || `does not match /${arg}/`,
  openapi: (p) => {
    const t = readText(p);
    return (/^openapi:\s*["']?3\./m.test(t) && /^paths:/m.test(t)) || 'not an OpenAPI 3 document with paths';
  },
  requirements: (p) => {
    const reqs = parseRequirements(p, ctx.phase);
    if (!frsOf(reqs).length) return 'no "### FR-x — title" requirement found';
    const noAcc = reqs.filter((q) => q.acceptance === 0).map((q) => q.id);
    return !noAcc.length || `no acceptance criteria: ${noAcc.join(', ')}`;
  },
  approved: (p) => isApproved(p) || 'not approved (no "Status: APPROVED" line) — the user must approve it',
  specsCoverFrs: () => {
    const specs = parseSpecs(ctx.phaseDir);
    const frs = frsOf(phaseReqs()).map((f) => f.id);
    const known = new Set(frsOf(allRequirements(ctx.appDir)).map((f) => f.id));
    const problems = [];
    for (const id of frs) {
      const n = specs.filter((s) => s.covers.includes(id)).length;
      if (n !== 1) problems.push(`${id} is in ${n} specs (needs exactly 1)`);
    }
    for (const s of specs) {
      if (!s.covers.length) problems.push(`${s.file} has no "Covers: FR-x" line`);
      for (const id of s.covers) if (!known.has(id)) problems.push(`${s.file} covers unknown ${id}`);
    }
    return !problems.length || problems.join('; ');
  },
  planCoversFrs: () => {
    const slices = plan();
    if (!slices.length) return 'no slice rows ("| 01_name | FR-1 | — | scope |") found';
    const problems = [];
    for (const f of frsOf(phaseReqs())) {
      const n = slices.filter((s) => s.frs.includes(f.id)).length;
      if (n !== 1) problems.push(`${f.id} is in ${n} slices (needs exactly 1)`);
    }
    const names = new Set(slices.map((s) => s.slice));
    for (const s of slices) for (const d of s.deps) if (!names.has(d)) problems.push(`${s.slice} depends on unknown ${d}`);
    if (hasCycle(slices)) problems.push('dependency graph has a cycle');
    return !problems.length || problems.join('; ');
  },
  // Step 4a: every FR of the slice says which earlier tests it supersedes and which ranges need exhaustive tests.
  sliceSpec: (p, arg, slice) => {
    const s = plan().find((x) => x.slice === slice);
    if (!s) return `${slice} is not in the plan`;
    const specs = parseSpecFrs(ctx.phaseDir);
    const problems = [];
    for (const id of s.frs) {
      const f = specs.get(id);
      if (!f) { problems.push(`${id} has no "### ${id}" section in 02_specs`); continue; }
      if (f.changes === null) problems.push(`${id} (${f.file}) lacks "- Changes earlier behaviour: none | <old> → <new> (tests: <files>)"`);
      for (const c of f.changes || []) {
        if (!c.named) problems.push(`${id}: change "${c.text.slice(0, 50)}" names no tests — add "(tests: <files>)" or "(tests: none)"`);
        for (const t of c.tests) {
          if (!testLayer(t)) problems.push(`${id}: "${t}" is not a test file path (app-relative)`);
          else if (!exists(path.join(ctx.appDir, t))) problems.push(`${id}: listed test ${t} does not exist`);
        }
      }
      if (!f.ranges) problems.push(`${id} (${f.file}) lacks "- Ranges & invariants: none | <ranges and invariants>"`);
    }
    return !problems.length || problems.join('; ');
  },
  reviewFile: (p) => Array.isArray(readJson(p)?.findings) || 'not valid JSON with a "findings" array',
  reviewClean: (p) => {
    const j = readJson(p);
    if (!Array.isArray(j?.findings)) return 'not valid JSON with a "findings" array';
    const open = j.findings.filter((f) => f.status === 'open' && f.severity !== 'low');
    return !open.length || `${open.length} open high/medium finding(s)`;
  },
  playwrightGreen: (p) => {
    const s = readJson(p)?.stats;
    if (!s) return 'not a Playwright JSON report';
    if (s.unexpected > 0) return `${s.unexpected} E2E test(s) failed`;
    return s.expected > 0 || 'no E2E test ran';
  },
  mentionsEveryFr: (p) => {
    const t = readText(p) || '';
    const miss = frsOf(allRequirements(ctx.appDir)).filter((f) => !new RegExp(`\\b${f.id}\\b`).test(t)).map((f) => f.id);
    return !miss.length || `missing ${miss.join(', ')}`;
  },
  mentionsPhaseFrs: (p) => {
    const t = readText(p) || '';
    const miss = frsOf(phaseReqs()).filter((f) => !new RegExp(`\\b${f.id}\\b`).test(t)).map((f) => f.id);
    return !miss.length || `missing ${miss.join(', ')}`;
  },
  evidenceLinks: (p) => {
    const bad = (readText(p) || '').split('\n').filter((l) => l.includes('✔') && !/\]\([^)]+\)/.test(l) && /FR-\d+/.test(l));
    return !bad.length || `${bad.length} ✔ line(s) without an evidence link`;
  },
  screenshotPerUiFr: (p) => {
    const files = exists(p) ? fs.readdirSync(p) : [];
    const skip = blockedFrs();
    const miss = phaseReqs().filter((q) => q.kind === 'FR' && q.ui && !skip.has(q.id))
      .filter((q) => !files.some((f) => f.startsWith(`${q.id}-`) && f.endsWith('.png'))).map((q) => q.id);
    return !miss.length || `no screenshot for UI requirement(s) ${miss.join(', ')}`;
  },
};

const only = args.only ? String(args.only).split(',') : null;
const skipRule = args['skip-rule'] ? String(args['skip-rule']).split(',') : [];

function checkItem(item, slice) {
  if (only && !only.some((o) => item.path.includes(o))) return;
  if (skipRule.includes(item.rule.split(':')[0])) return;
  const rel = item.path.replace('{phase}', ctx.phase).replace('{slice}', slice || '');
  const abs = path.join(ctx.appDir, rel);
  const [name, ...rest] = item.rule.split(':');
  const arg = rest.join(':');
  const label = `${rel} [${item.rule}]`;
  if (name === 'minFiles') {
    const dir = path.dirname(abs);
    const n = exists(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(path.extname(abs))).length : 0;
    return n >= Number(arg) ? r.pass(`${label} ${n} file(s)`) : r.missing(`${label} only ${n} file(s)`);
  }
  const dirRule = ['specsCoverFrs', 'screenshotPerUiFr', 'sliceSpec'].includes(name);
  if (!dirRule && !exists(abs)) return r.missing(label);
  const res = RULES[name] ? RULES[name](abs, arg, slice) : `unknown rule ${name}`;
  res === true ? r.pass(label) : r.invalid(`${label} — ${res}`);
}

const items = manifest[step] || [];
if (step !== '04_build') items.forEach((i) => checkItem(i, null));
else {
  const st = ctx.state?.slices || {};
  const targets = args.slice
    ? [[args.slice, args.stage || (st[args.slice] === 'BLOCKED' ? 'blocked' : 'done')]]
    : Object.entries(st).filter(([, v]) => v === 'DONE' || v === 'BLOCKED').map(([k, v]) => [k, v === 'BLOCKED' ? 'blocked' : 'done']);
  if (!targets.length) r.skip('no finished slices yet');
  for (const [slice, stage] of targets) {
    const want = stage === 'blocked'
      ? items.filter((i) => i.stage === 'blocked' || i.stage === 'red')
      : items.filter((i) => i.stage !== 'blocked' && STAGE_ORDER.indexOf(i.stage) <= STAGE_ORDER.indexOf(stage))
        .filter((i) => args.slice || i.stage !== 'spec');
    for (const i of want) {
      if (i.onlyIfRounds) {
        const round = readJson(path.join(ctx.phaseDir, '04_build', slice, 'review-findings.json'))?.round ?? 1;
        if (round <= 1) continue;
      }
      checkItem(i, slice);
    }
  }
}
process.exit(r.finish());
