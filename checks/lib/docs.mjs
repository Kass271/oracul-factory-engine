// Parsers for the phase documents. The formats are fixed by templates/docs/*.
import fs from 'node:fs';
import path from 'node:path';
import { exists, listPhases, readText, walk } from './core.mjs';

const REQ_HEADING = /^#{2,4}\s+((?:FR|NFR)-(\d+))\b\s*[—:-]?\s*(.*)$/;

// requirements.md: "### FR-1 — Title" followed by "- UI: yes|no" and "- Acceptance:" with nested bullets.
export function parseRequirements(file, phase) {
  const text = readText(file);
  if (text === null) return null;
  const reqs = [];
  let cur = null, inAcc = false;
  for (const line of text.split('\n')) {
    const h = line.match(REQ_HEADING);
    if (h) {
      cur = { id: h[1], num: Number(h[2]), kind: h[1].split('-')[0], title: h[3].trim(), phase, ui: false, acceptance: 0 };
      reqs.push(cur); inAcc = false; continue;
    }
    if (/^#{1,4}\s/.test(line)) { cur = null; continue; }
    if (!cur) continue;
    if (/^\s*-\s*UI:\s*yes/i.test(line)) cur.ui = true;
    if (/^\s*-\s*Acceptance:/i.test(line)) { inAcc = true; continue; }
    if (inAcc && /^\s{2,}-\s+\S/.test(line)) cur.acceptance++;
    else if (inAcc && /^\s*-\s*\w+:/.test(line)) inAcc = false;
  }
  return reqs;
}

export function allRequirements(appDir) {
  const out = [];
  for (const ph of listPhases(appDir)) {
    const reqs = parseRequirements(path.join(appDir, 'docs', ph, '01_scope', 'requirements.md'), ph);
    if (reqs) out.push(...reqs);
  }
  return out;
}

export const frsOf = (reqs) => reqs.filter((r) => r.kind === 'FR');

export const isApproved = (file) => /^Status:\s*APPROVED\b/m.test(readText(file) || '');

// specs: each 02_specs/<capability>.md has a line "Covers: FR-1, FR-2".
export function parseSpecs(phaseDir) {
  const dir = path.join(phaseDir, '02_specs');
  if (!exists(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'contract-notes.md').map((f) => {
    const m = (readText(path.join(dir, f)) || '').match(/^Covers:\s*(.+)$/m);
    return { file: f, covers: m ? (m[1].match(/FR-\d+/g) || []) : [] };
  });
}

// The two slice-planning lines of each "### FR-x" section in 02_specs/*.md (written in Step 4a):
//   - Changes earlier behaviour: none | <old> → <new> (tests: <file>, <file> | none)   (one line per change)
//   - Ranges & invariants: none | <input ranges / invariants that need an exhaustive or parameterized test>
// Map FR-x -> { file, changes: null (line missing) | [{ text, tests: [rel] }] ([] = none), ranges: null | text }
export function parseSpecFrs(phaseDir) {
  const map = new Map();
  for (const s of parseSpecs(phaseDir)) {
    let cur = null;
    for (const line of (readText(path.join(phaseDir, '02_specs', s.file)) || '').split('\n')) {
      const h = line.match(REQ_HEADING);
      if (h) { cur = { id: h[1], file: s.file, changes: null, ranges: null }; map.set(h[1], cur); continue; }
      if (/^#{1,3}\s/.test(line)) { cur = null; continue; }
      if (!cur) continue;
      const c = line.match(/^\s*-\s*Changes earlier behaviour:\s*(.*)$/i);
      if (c) {
        cur.changes ??= [];
        if (!/^none\b/i.test(c[1].trim())) {
          const t = c[1].match(/\(tests:\s*([^)]*)\)/);
          const tests = t ? t[1].split(/[,\s]+/).map((x) => x.replace(/(#|::).*$/, '')).filter((x) => x && !/^none$/i.test(x)) : [];
          cur.changes.push({ text: c[1].trim(), named: !!t, tests });
        }
      }
      const r = line.match(/^\s*-\s*Ranges & invariants:\s*(.*)$/i);
      if (r) cur.ranges = r[1].trim();
    }
  }
  return map;
}

// plan.md slice table rows: | 01_auth | FR-1, FR-2 | — | scope text |
export function parsePlan(phaseDir) {
  const text = readText(path.join(phaseDir, '03_plan', 'plan.md'));
  if (text === null) return null;
  const slices = [];
  for (const line of text.split('\n')) {
    const cells = line.split('|').map((c) => c.trim());
    if (cells.length < 4 || !/^\d\d_[a-z0-9-]+$/.test(cells[1])) continue;
    slices.push({
      slice: cells[1],
      frs: cells[2].match(/FR-\d+/g) || [],
      deps: (cells[3].match(/\d\d_[a-z0-9-]+/g) || []),
      scope: cells[4] || '',
    });
  }
  return slices;
}

// Slices that (transitively) depend on `slice`.
export function dependents(slices, slice) {
  const out = new Set();
  let grew = true;
  while (grew) {
    grew = false;
    for (const s of slices) {
      if (!out.has(s.slice) && s.deps.some((d) => d === slice || out.has(d))) { out.add(s.slice); grew = true; }
    }
  }
  return [...out];
}

export function hasCycle(slices) {
  const byName = Object.fromEntries(slices.map((s) => [s.slice, s]));
  const seen = new Map();
  const visit = (n) => {
    if (seen.get(n) === 1) return true;
    if (seen.get(n) === 2 || !byName[n]) return false;
    seen.set(n, 1);
    const c = byName[n].deps.some(visit);
    seen.set(n, 2);
    return c;
  };
  return slices.some((s) => visit(s.slice));
}

// ---------- tests and @trace tags ----------
export function testLayer(rel) {
  if (/^backend\/src\/test\/.*\.java$/.test(rel)) return 'backend';
  if (/^frontend\/src\/.*\.spec\.ts$/.test(rel)) return 'frontend';
  if (/^e2e\/.*\.(spec|test)\.ts$/.test(rel)) return 'e2e';
  return null;
}

export function testFiles(appDir) {
  return walk(appDir, (p) => testLayer(path.relative(appDir, p).split(path.sep).join('/')) !== null)
    .map((p) => ({ abs: p, rel: path.relative(appDir, p).split(path.sep).join('/') }));
}

// Map FR-x -> [{rel, layer}] from "@trace FR-1, FR-2" comments.
export function collectTraces(appDir) {
  const map = new Map();
  for (const f of testFiles(appDir)) {
    const text = readText(f.abs) || '';
    for (const m of text.matchAll(/@trace\s+((?:FR-\d+[\s,]*)+)/g)) {
      for (const id of m[1].match(/FR-\d+/g)) {
        if (!map.has(id)) map.set(id, []);
        if (!map.get(id).some((x) => x.rel === f.rel)) map.get(id).push({ rel: f.rel, layer: testLayer(f.rel) });
      }
    }
  }
  return map;
}
