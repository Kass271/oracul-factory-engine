// E2E helpers for bin/stack.mjs: the environment of official vs scratch runs, and the "E2E FAILURES" block.
// Official runs write e2e/report, e2e/test-results and the QA screenshots; scratch runs (tester, test-fix only)
// write next to them and never touch official evidence.
import path from 'node:path';
import { exists, readJson } from './core.mjs';
import { collectTraces, parsePlan, parseSpecFrs } from './docs.mjs';

export const SCRATCH = { report: 'report-scratch', output: 'test-results-scratch' };
// Focus run (workflow, fix rounds): the slice's related E2E specs + last failures, before the full official run.
export const FOCUS = { report: 'report-focus', output: 'test-results-focus' };

// kind: 'official' | 'scratch' | 'focus' (scratch: true is the older spelling of kind 'scratch')
export function e2eEnv({ appDir, phaseDir, scratch, kind }) {
  const e2e = path.join(appDir, 'e2e');
  const k = kind || (scratch ? 'scratch' : 'official');
  const dirs = k === 'scratch' ? SCRATCH : k === 'focus' ? FOCUS : null;
  return dirs
    ? { E2E_REPORT_DIR: dirs.report, E2E_OUTPUT_DIR: dirs.output, QA_SCREENSHOTS_DIR: path.join(e2e, dirs.report, 'screenshots') }
    : { QA_SCREENSHOTS_DIR: path.join(phaseDir, '05_release', 'qa', 'screenshots') };
}

// The E2E spec files a focus run covers (paths relative to e2e/tests, as Playwright filters them):
// specs tagged with the slice's FRs, e2e files the spec supersedes, and specs that failed in the last official or
// focus run. [] = nothing to focus on.
export function e2eFocus({ appDir, phaseDir, slice }) {
  const s = (parsePlan(phaseDir) || []).find((p) => p.slice === slice);
  if (!s) return [];
  const traces = collectTraces(appDir);
  const specs = parseSpecFrs(phaseDir);
  const out = new Set();
  const add = (rel) => { const m = rel.match(/^e2e\/tests\/(.+\.(?:spec|test)\.ts)$/); if (m && exists(path.join(appDir, rel))) out.add(m[1]); };
  for (const f of s.frs) for (const t of traces.get(f) || []) if (t.layer === 'e2e') add(t.rel);
  for (const f of s.frs) for (const c of specs.get(f)?.changes || []) for (const t of c.tests) add(t);
  for (const dir of ['report', FOCUS.report]) {
    for (const t of failedTests(readJson(path.join(appDir, 'e2e', dir, 'results.json')))) add(`e2e/tests/${t.file}`);
  }
  return [...out].sort();
}

// Problems if a scratch env could write official output. [] = safe.
export function scratchEnvProblems(env, appDir) {
  const e2e = path.join(appDir, 'e2e');
  const inside = (p, dir) => { const r = path.relative(dir, p); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
  const problems = [];
  const rep = env.E2E_REPORT_DIR && path.resolve(e2e, env.E2E_REPORT_DIR);
  const out = env.E2E_OUTPUT_DIR && path.resolve(e2e, env.E2E_OUTPUT_DIR);
  const shots = env.QA_SCREENSHOTS_DIR && path.resolve(e2e, env.QA_SCREENSHOTS_DIR);
  if (!rep || inside(rep, path.join(e2e, 'report'))) problems.push(`E2E_REPORT_DIR=${env.E2E_REPORT_DIR ?? '(unset)'} writes the official report`);
  if (!out || inside(out, path.join(e2e, 'test-results'))) problems.push(`E2E_OUTPUT_DIR=${env.E2E_OUTPUT_DIR ?? '(unset)'} wipes the official traces`);
  if (!shots || inside(shots, path.join(appDir, 'docs'))) problems.push(`QA_SCREENSHOTS_DIR=${env.QA_SCREENSHOTS_DIR ?? '(unset)'} writes QA evidence`);
  return problems;
}

// The app's playwright.config.ts must read both variables, or a scratch run would overwrite official output.
export const scratchSupported = (configText) => /E2E_REPORT_DIR/.test(configText || '') && /E2E_OUTPUT_DIR/.test(configText || '');

// Playwright filter: a spec file (…ts) is a positional file filter, anything else a --grep on test titles.
export const filterArgs = (pattern) => (/\.(spec|test)\.ts$|\.ts$/.test(pattern) ? [pattern] : ['--grep', pattern]);

const strip = (s) => String(s || '').replace(/\u001b\[[0-9;]*m/g, '');

// Failed tests from a Playwright JSON report → [{ file, title, error: [lines], attachments: [paths] }].
export function failedTests(report) {
  const out = [];
  const walk = (suite, file) => {
    const f = suite.file || file;
    for (const spec of suite.specs || []) {
      for (const t of spec.tests || []) {
        if (t.status !== 'unexpected') continue;
        const last = (t.results || []).at(-1) || {};
        const err = last.error?.message || last.errors?.[0]?.message || last.error?.stack || '(no error message)';
        out.push({
          file: spec.file || f || '?',
          title: [spec.title, t.projectName].filter(Boolean).join(' · '),
          error: strip(err).split('\n').filter((l) => l.trim()),
          attachments: (last.attachments || []).filter((a) => a.path && /trace|screenshot|video/.test(a.name || a.contentType || '')).map((a) => a.path),
        });
      }
    }
    for (const s of suite.suites || []) walk(s, f);
  };
  for (const s of report?.suites || []) walk(s, s.file);
  return out;
}

// Block printed last by `stack.mjs e2e` on failure; sized to fit the last 80 lines the workflow runner returns.
// Failures with the same first error lines are one group ("✘ 12 tests: …"): one cause, not twelve problems.
export function failureBlock(report, appDir, { maxFailures = 10, budget = 60 } = {}) {
  const fails = failedTests(report);
  if (!fails.length) return '';
  const rel = (p) => (path.isAbsolute(p) && appDir ? path.relative(appDir, p) : p);
  const groups = new Map();
  for (const f of fails) {
    const key = f.error.slice(0, 3).join('\n');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  const list = [...groups.values()];
  const shown = list.slice(0, maxFailures);
  const perErr = Math.max(3, Math.min(15, Math.floor(budget / shown.length) - 3));
  const lines = [`==== E2E FAILURES (${fails.length}${list.length < fails.length ? ` in ${list.length} group${list.length > 1 ? 's' : ''}` : ''}) ====`];
  for (const g of shown) {
    const f = g[0];
    if (g.length === 1) lines.push(`✘ ${f.file} › ${f.title}`);
    else {
      lines.push(`✘ ${g.length} tests, same error:`);
      for (const t of g.slice(0, 6)) lines.push(`    · ${t.file} › ${t.title}`);
      if (g.length > 6) lines.push(`    · … ${g.length - 6} more`);
    }
    lines.push(...f.error.slice(0, perErr).map((l) => `    ${l}`));
    for (const a of f.attachments) lines.push(`    attachment: ${rel(a)}`);
  }
  const hidden = list.slice(shown.length).reduce((n, g) => n + g.length, 0);
  if (hidden) lines.push(`… ${hidden} more failure(s) in the JSON report`);
  lines.push('==== END E2E FAILURES ====');
  return lines.join('\n');
}
