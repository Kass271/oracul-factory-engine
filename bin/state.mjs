#!/usr/bin/env node
// The ONLY writer of factory-engine/state/. Every state transition goes through here.
//
//   init <app> [--title "Room booking"]     create app state + make it active
//   use <app>                               switch active app
//   show [--json]                           print active app state
//   paths [--json]                          absolute engine/app/phase paths (for skills/workflows)
//   phase new <name>                        start phase-NN_<name>, create docs/<phase>/00..05
//   set step|slice|subStep <value>
//   round +1|reset
//   slice <name> PENDING|IN_PROGRESS|DONE|BLOCKED
//   slices-from-plan                        load slices of the current phase plan as PENDING
//   next-slice                              next buildable slice (deps DONE) or "none"
//   impact <slice>                          slices that depend on <slice> (STOP if any)
//   approve scope|plan                      stamp the doc "Status: APPROVED ✔ <date>" + record it
//   next-fr                                 next free FR / NFR numbers across all phases
import fs from 'node:fs';
import path from 'node:path';
import {
  APPS_DIR, ENGINE, ROOT, STEPS, SUBSTEPS, SLICE_STATUS, context, listPhases, loadActive, loadState,
  parseArgs, saveState, statePath, today, writeJson, activePath, exists, readText,
} from '../checks/lib/core.mjs';
import { allRequirements, dependents, parsePlan } from '../checks/lib/docs.mjs';

const args = parseArgs();
const [cmd, a1, a2] = args._;
const die = (m) => { console.error(`state: ${m}`); process.exit(1); };

function need() {
  const ctx = context(args);
  if (!ctx.app) die('no active app — run: state.mjs init <app>');
  if (!ctx.state) die(`no state for app "${ctx.app}"`);
  return ctx;
}
const save = (ctx) => { ctx.state.updatedAt = new Date().toISOString(); saveState(ctx.app, ctx.state); };

switch (cmd) {
  case 'init': {
    if (!a1 || !/^[a-z][a-z0-9-]{1,40}$/.test(a1)) die('init <app>: lowercase name, letters/digits/dashes');
    if (loadState(a1)) die(`app "${a1}" already exists`);
    saveState(a1, {
      app: a1, title: args.title || a1, createdAt: new Date().toISOString(), phase: null, phases: [],
      step: null, slice: null, subStep: 'none', round: 0, slices: {}, approvals: {}, lastVerify: null,
    });
    writeJson(activePath(), { app: a1, phase: null });
    console.log(`app ${a1} initialised and active`);
    break;
  }
  case 'use': {
    if (!loadState(a1)) die(`unknown app "${a1}"`);
    writeJson(activePath(), { app: a1, phase: loadState(a1).phase });
    console.log(`active app: ${a1}`);
    break;
  }
  case 'show': {
    const ctx = context(args);
    if (!ctx.app) { console.log(args.json ? '{}' : 'no active app'); break; }
    if (args.json) console.log(JSON.stringify(ctx.state, null, 2));
    else {
      const s = ctx.state || {};
      console.log(`app ${ctx.app} · phase ${s.phase} · step ${s.step} · slice ${s.slice ?? '-'} · subStep ${s.subStep} · round ${s.round}`);
      for (const [k, v] of Object.entries(s.slices || {})) console.log(`  ${k.padEnd(24)} ${v}`);
      console.log(`  approvals: ${JSON.stringify(s.approvals || {})}`);
      console.log(`  last verify: ${s.lastVerify ? `${s.lastVerify.result} @ ${s.lastVerify.at} ${s.lastVerify.failing?.join(', ') || ''}` : 'never'}`);
    }
    break;
  }
  case 'paths': {
    const ctx = context(args);
    const p = {
      engine: ENGINE, root: ROOT, appsDir: APPS_DIR, app: ctx.app, appDir: ctx.appDir, phase: ctx.phase,
      phaseDir: ctx.phaseDir, statePath: ctx.app ? statePath(ctx.app) : null,
      workflows: { buildSlice: path.join(ENGINE, 'workflows', 'build-slice.js'), finishAndRun: path.join(ENGINE, 'workflows', 'finish-and-run.js') },
    };
    console.log(args.json ? JSON.stringify(p, null, 2) : Object.entries(p).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('\n'));
    break;
  }
  case 'phase': {
    if (a1 !== 'new' || !a2 || !/^[a-z0-9-]{2,40}$/.test(a2)) die('phase new <name> (lowercase, digits, dashes)');
    const ctx = need();
    const n = listPhases(ctx.appDir).length + 1;
    const phase = `phase-${String(n).padStart(2, '0')}_${a2}`;
    for (const s of STEPS) fs.mkdirSync(path.join(ctx.appDir, 'docs', phase, s), { recursive: true });
    fs.mkdirSync(path.join(ctx.appDir, 'docs', phase, '05_release', 'qa', 'screenshots'), { recursive: true });
    Object.assign(ctx.state, { phase, step: '00_setup', slice: null, subStep: 'none', round: 0, slices: {}, approvals: {} });
    ctx.state.phases = [...(ctx.state.phases || []), phase];
    save(ctx);
    writeJson(activePath(), { app: ctx.app, phase });
    console.log(phase);
    break;
  }
  case 'set': {
    const ctx = need();
    const allowed = { step: STEPS, subStep: SUBSTEPS };
    if (!['step', 'slice', 'subStep'].includes(a1)) die('set step|slice|subStep <value>');
    if (allowed[a1] && !allowed[a1].includes(a2)) die(`${a1} must be one of ${allowed[a1].join(', ')}`);
    ctx.state[a1] = a2 === 'none' && a1 === 'slice' ? null : a2;
    if (a1 === 'slice') ctx.state.round = 0;
    save(ctx);
    console.log(`${a1} = ${a2}`);
    break;
  }
  case 'round': {
    const ctx = need();
    if (a1 === '+1') ctx.state.round = (ctx.state.round || 0) + 1;
    else if (a1 === 'reset') ctx.state.round = 0;
    else die('round +1|reset');
    save(ctx);
    console.log(ctx.state.round);
    break;
  }
  case 'slice': {
    const ctx = need();
    if (!a1 || !SLICE_STATUS.includes(a2)) die(`slice <name> ${SLICE_STATUS.join('|')}`);
    ctx.state.slices[a1] = a2;
    save(ctx);
    console.log(`${a1} ${a2}`);
    break;
  }
  case 'slices-from-plan': {
    const ctx = need();
    const plan = parsePlan(ctx.phaseDir);
    if (!plan || !plan.length) die('no slices found in 03_plan/plan.md');
    for (const s of plan) if (!ctx.state.slices[s.slice]) ctx.state.slices[s.slice] = 'PENDING';
    save(ctx);
    console.log(plan.map((s) => s.slice).join('\n'));
    break;
  }
  case 'next-slice': {
    const ctx = need();
    const plan = parsePlan(ctx.phaseDir) || [];
    const st = ctx.state.slices;
    const next = plan.find((s) => (st[s.slice] ?? 'PENDING') !== 'DONE' && st[s.slice] !== 'BLOCKED'
      && s.deps.every((d) => st[d] === 'DONE'));
    const stuck = plan.filter((s) => (st[s.slice] ?? 'PENDING') === 'PENDING' && s.deps.some((d) => st[d] === 'BLOCKED'));
    if (args.json) console.log(JSON.stringify({ next: next?.slice ?? null, frs: next?.frs ?? [], skippedBecauseBlocked: stuck.map((s) => s.slice) }));
    else console.log(next ? next.slice : 'none');
    break;
  }
  case 'impact': {
    const ctx = need();
    const deps = dependents(parsePlan(ctx.phaseDir) || [], a1);
    console.log(JSON.stringify({ slice: a1, dependents: deps, decision: deps.length ? 'STOP' : 'CONTINUE' }));
    break;
  }
  case 'approve': {
    const ctx = need();
    const file = { scope: path.join(ctx.phaseDir, '01_scope', 'requirements.md'), plan: path.join(ctx.phaseDir, '03_plan', 'plan.md') }[a1];
    if (!file) die('approve scope|plan');
    const text = readText(file);
    if (text === null) die(`${path.relative(ctx.appDir, file)} does not exist`);
    const stamp = `Status: APPROVED ✔ ${today()}`;
    const next = /^Status:.*$/m.test(text) ? text.replace(/^Status:.*$/m, stamp) : text.replace(/^(# .*\n)/, `$1\n${stamp}\n`);
    fs.writeFileSync(file, next);
    ctx.state.approvals[a1] = today();
    save(ctx);
    console.log(`${a1} approved ${today()}`);
    break;
  }
  case 'next-fr': {
    const ctx = need();
    const reqs = allRequirements(ctx.appDir);
    const max = (k) => Math.max(0, ...reqs.filter((r) => r.kind === k).map((r) => r.num));
    console.log(JSON.stringify({ nextFR: `FR-${max('FR') + 1}`, nextNFR: `NFR-${max('NFR') + 1}` }));
    break;
  }
  default:
    console.log(fs.readFileSync(new URL(import.meta.url)).toString().split('\n').filter((l) => l.startsWith('//')).join('\n'));
    if (cmd) process.exit(1);
}
