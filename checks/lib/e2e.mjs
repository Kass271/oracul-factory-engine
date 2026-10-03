// E2E helpers for bin/stack.mjs: the environment of official vs scratch runs, and the "E2E FAILURES" block.
// Official runs write e2e/report, e2e/test-results and the QA screenshots; scratch runs (tester, test-fix only)
// write next to them and never touch official evidence.
import path from 'node:path';

export const SCRATCH = { report: 'report-scratch', output: 'test-results-scratch' };

export function e2eEnv({ appDir, phaseDir, scratch }) {
  const e2e = path.join(appDir, 'e2e');
  return scratch
    ? { E2E_REPORT_DIR: SCRATCH.report, E2E_OUTPUT_DIR: SCRATCH.output, QA_SCREENSHOTS_DIR: path.join(e2e, SCRATCH.report, 'screenshots') }
    : { QA_SCREENSHOTS_DIR: path.join(phaseDir, '05_release', 'qa', 'screenshots') };
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
export function failureBlock(report, appDir, { maxFailures = 10, budget = 60 } = {}) {
  const fails = failedTests(report);
  if (!fails.length) return '';
  const shown = fails.slice(0, maxFailures);
  const perErr = Math.max(3, Math.min(15, Math.floor(budget / shown.length) - 3));
  const rel = (p) => (path.isAbsolute(p) && appDir ? path.relative(appDir, p) : p);
  const lines = [`==== E2E FAILURES (${fails.length}) ====`];
  for (const f of shown) {
    lines.push(`✘ ${f.file} › ${f.title}`);
    lines.push(...f.error.slice(0, perErr).map((l) => `    ${l}`));
    for (const a of f.attachments) lines.push(`    attachment: ${rel(a)}`);
  }
  if (fails.length > shown.length) lines.push(`… ${fails.length - shown.length} more failure(s) in the JSON report`);
  lines.push('==== END E2E FAILURES ====');
  return lines.join('\n');
}

