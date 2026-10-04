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
