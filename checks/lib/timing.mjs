// Where the time goes: subStep timings (state/apps/<app>/timings.jsonl, written by `state.mjs set subStep`) and the
// slowest test classes / Spring contexts of a Gradle run (JUnit XML). Pure over its inputs so the self-test can drive it.
import fs from 'node:fs';
import path from 'node:path';
import { exists, readText, took } from './core.mjs';

// timings.jsonl lines → [{ slice, total, steps: [{ subStep, ms }] }] in order of first appearance. A malformed line is
// skipped. The last open subStep runs until `now` (ms) when given, otherwise it is left out.
export function summariseTimings(text, now = null) {
  const rows = String(text || '').split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((r) => r && r.at && r.to && !Number.isNaN(Date.parse(r.at)));
  const slices = new Map();
  rows.forEach((r, i) => {
    const end = rows[i + 1] ? Date.parse(rows[i + 1].at) : now;
    if (end === null || r.to === 'none') return;
    const key = r.slice || '(no slice)';
    if (!slices.has(key)) slices.set(key, new Map());
    const m = slices.get(key);
    m.set(r.to, (m.get(r.to) || 0) + Math.max(0, end - Date.parse(r.at)));
  });
  return [...slices].map(([slice, m]) => ({ slice, total: [...m.values()].reduce((a, b) => a + b, 0), steps: [...m].map(([subStep, ms]) => ({ subStep, ms })) }));
}

export const formatTimings = (summary) => summary.map((s) => `${s.slice}: ${took(s.total)} — ${s.steps.map((x) => `${x.subStep} ${took(x.ms)}`).join(' · ')}`).join('\n');

const xmlFiles = (dir) => (exists(dir) ? fs.readdirSync(dir).filter((f) => /^TEST-.*\.xml$/.test(f)).map((f) => path.join(dir, f)) : []);

// The n slowest test classes of a Gradle run: [{ name, seconds, tests }].
export function slowestClasses(dir, n = 10) {
  const out = [];
  for (const f of xmlFiles(dir)) {
    const head = (readText(f) || '').match(/<testsuite\b([^>]*)>/);
    if (!head) continue;
    const attr = (k) => (head[1].match(new RegExp(`\\b${k}="([^"]*)"`)) || [])[1];
    out.push({ name: attr('name') || path.basename(f), seconds: Number(attr('time')) || 0, tests: Number(attr('tests')) || 0 });
  }
  return out.sort((a, b) => b.seconds - a.seconds).slice(0, n);
}

// Spring application contexts started during the run (each distinct test configuration starts one).
export function springContexts(dir) {
  let n = 0;
  for (const f of xmlFiles(dir)) n += ((readText(f) || '').match(/Started \S+ in [\d.]+ seconds/g) || []).length;
  return n;
}

export function slowReport(dir, n = 10) {
  const top = slowestClasses(dir, n);
  if (!top.length) return '';
  const lines = top.map((c) => `  ${c.seconds.toFixed(1).padStart(7)}s  ${c.name} (${c.tests} test${c.tests === 1 ? '' : 's'})`);
  return [`Slowest test classes (${springContexts(dir)} Spring context start(s) in this run):`, ...lines].join('\n');
}

// Suite health (F6) — warnings only, never a failure. prev = the last snapshot (state/apps/<app>/suite-health.json).
// → { warnings: [text], snapshot }
const REAL_TIME = /Thread\.sleep\s*\(|TimeUnit\.\w+\.sleep\s*\(|atMost\s*\(\s*(?:Duration\.ofSeconds\s*\(\s*([5-9]|\d\d+)|Duration\.ofMillis\s*\(\s*([5-9]\d{3}|\d{5,})|([5-9]|\d\d+)\s*,\s*TimeUnit\.SECONDS)|System\.currentTimeMillis\s*\(\)|Instant\.now\s*\(\)/;
export function suiteHealth(appDir, prev = null, { classSlow = 30, classNew = 20, contexts = 20, e2eMax = 50 } = {}) {
  const dir = path.join(appDir, 'backend/build/test-results/test');
  const classes = slowestClasses(dir, 1000);
  const ctx = springContexts(dir);
  const warnings = [];
  const was = (v) => (v === undefined || v === null ? '' : ` (was ${v})`);
  for (const c of classes.filter((x) => x.seconds > classNew)) {
    const isNew = prev?.classes && prev.classes[c.name] === undefined;
    if (c.seconds <= classSlow && !isNew) continue;
    const file = path.join(appDir, `backend/src/test/java/${c.name.replace(/\$.*$/, '').replace(/\./g, '/')}.java`);
    const src = readText(file) || '';
    const rt = REAL_TIME.test(src) ? ' — real-time wait in the test (sleep / long atMost / wall clock): inject a Clock or fake time' : '';
    warnings.push(`test class ${c.name} took ${c.seconds.toFixed(0)}s${was(prev?.classes?.[c.name]?.toFixed?.(0))}${isNew ? ' — new since the last slice' : ''}${rt}`);
  }
  if (ctx > contexts) warnings.push(`${ctx} Spring context starts${was(prev?.contexts)} — share one test configuration (each distinct @MockitoBean/property set starts a context)`);
  const cfg = readText(path.join(appDir, 'e2e/playwright.config.ts')) || '';
  const rep = (() => { try { return JSON.parse(readText(path.join(appDir, 'e2e/report/results.json')) || 'null'); } catch { return null; } })();
  const st = rep?.stats || {};
  const e2eTests = (st.expected || 0) + (st.unexpected || 0) + (st.flaky || 0) + (st.skipped || 0);
  const workers = (cfg.match(/^\s*workers\s*:\s*(\d+)/m) || [])[1];
  if (workers === '1' && e2eTests > e2eMax) warnings.push(`E2E: workers: 1 with ${e2eTests} tests${was(prev?.e2eTests)} — the suite runs serially; isolate test data and raise workers`);
  // A project used as a dependency runs with every scoped run — it must be setup only.
  const deps = [...cfg.matchAll(/dependencies\s*:\s*\[([^\]]*)\]/g)].flatMap((m) => [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]));
  if (deps.length && rep) {
    const perProject = {};
    const walk = (s) => { for (const sp of s.specs || []) for (const t of sp.tests || []) perProject[t.projectName] = (perProject[t.projectName] || 0) + 1; (s.suites || []).forEach(walk); };
    (rep.suites || []).forEach(walk);
    for (const d of new Set(deps)) if ((perProject[d] || 0) > 5) warnings.push(`E2E: dependency project "${d}" contains ${perProject[d]} tests — it runs with every scoped run; keep dependency projects to setup`);
  }
  return { warnings, snapshot: { at: new Date().toISOString(), contexts: ctx, classes: Object.fromEntries(classes.map((c) => [c.name, c.seconds])), e2eTests, workers: workers ? Number(workers) : null } };
}
