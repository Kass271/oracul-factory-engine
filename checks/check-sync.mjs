#!/usr/bin/env node
// Rule: the contract sync (subStep sync) only makes production code COMPILE again after a contract change — it never
// adds behaviour. Every line it adds to production code (diff against the last commit, plus new files) must be one of:
//   blank / comment · import / package · annotation · braces and punctuation only · a declaration line (class, enum
//   constant, method signature without "=" or "return") · a line with the sync marker (NotImplementedException /
//   notImplemented()) · a removed line with a rename declared in 02_specs/contract-notes.md ("Renamed: Old → New").
// A removed line needs such a renamed counterpart (sync never deletes code). The marker files themselves are allowed
// when they equal the engine templates.
//   --release   no sync marker may be left in production code (every contract operation is implemented)
import fs from 'node:fs';
import path from 'node:path';
import { ENGINE, Report, context, parseArgs, readText, run, walk } from './lib/core.mjs';

const args = parseArgs();
const ctx = context(args);
const r = new Report(args.release ? 'sync markers (release)' : 'contract sync');
if (!ctx.appDir) { r.invalid('no app selected'); process.exit(r.finish()); }
const MARKER = /\bNotImplementedException\b|\bnotImplemented\s*\(/;
const MARKER_FILES = {
  'backend/src/main/java/com/oracul/app/common/NotImplementedException.java': 'templates/app/backend/src/main/java/com/oracul/app/common/NotImplementedException.java',
  'frontend/src/app/not-implemented.ts': 'templates/app/frontend/src/app/not-implemented.ts',
};
const isProd = (rel) => (/^backend\/src\/main\//.test(rel) || /^frontend\/src\//.test(rel)) && !/^frontend\/src\/app\/api\//.test(rel) && !/\.spec\.ts$/.test(rel);

if (args.release) {
  const hits = [];
  for (const dir of ['backend/src/main', 'frontend/src']) {
    for (const f of walk(path.join(ctx.appDir, dir), (p) => /\.(java|ts)$/.test(p))) {
      const rel = path.relative(ctx.appDir, f).split(path.sep).join('/');
      if (!isProd(rel) || MARKER_FILES[rel]) continue;
      (readText(f) || '').split('\n').forEach((l, i) => { if (MARKER.test(l) && !/^\s*(import|\/\/|\*)/.test(l)) hits.push(`${rel}:${i + 1}`); });
    }
  }
  if (hits.length) r.invalid(`sync markers left (operations the contract has but no slice implemented): ${hits.slice(0, 10).join(', ')}${hits.length > 10 ? ` … ${hits.length - 10} more` : ''}`);
  else r.pass('no sync marker left in production code');
  process.exit(r.finish());
}

const renames = [...(readText(path.join(ctx.phaseDir || '', '02_specs', 'contract-notes.md')) || '').matchAll(/^\s*[-*]?\s*Renamed:\s*([\w.$]+)\s*(?:→|->)\s*([\w.$]+)/gm)].map((m) => [m[1], m[2]]);
const applyRenames = (l) => renames.reduce((s, [a, b]) => s.replace(new RegExp(`\\b${a.replace(/[.$]/g, '\\$&')}\\b`, 'g'), b), l);

const diff = run('git', ['-C', ctx.appDir, 'diff', 'HEAD', '--unified=0', '--no-color', '--', 'backend/src/main', 'frontend/src']);
if (diff.code !== 0) { r.invalid('git diff failed — the sync check needs the app repository'); process.exit(r.finish()); }
const added = []; // { rel, line }
const removed = [];
let file = null;
for (const l of diff.out.split('\n')) {
  if (l.startsWith('+++ ')) { file = l.slice(4).replace(/^b\//, ''); continue; }
  if (l.startsWith('--- ') || l.startsWith('diff ') || l.startsWith('index ') || l.startsWith('@@')) continue;
  if (!file || !isProd(file)) continue;
  if (l.startsWith('+')) added.push({ rel: file, line: l.slice(1) });
  else if (l.startsWith('-')) removed.push({ rel: file, line: l.slice(1) });
}
const untracked = run('git', ['-C', ctx.appDir, 'ls-files', '--others', '--exclude-standard', '--', 'backend/src/main', 'frontend/src']);
for (const rel of untracked.out.split('\n').filter(Boolean)) {
  if (!isProd(rel)) continue;
  if (MARKER_FILES[rel] && readText(path.join(ctx.appDir, rel)) === readText(path.join(ENGINE, MARKER_FILES[rel]))) continue;
  for (const line of (readText(path.join(ctx.appDir, rel)) || '').split('\n')) added.push({ rel, line });
}

const trivial = (t) => t === '' || /^(\/\/|\/\*|\*|\*\/)/.test(t) || /^(import|package)\b/.test(t) || /^export\s+(\*|\{[^}]*\})\s+from\b/.test(t)
  || /^@[\w.]+(\(.*\))?$/.test(t) || /^[{}()[\];,]*$/.test(t);
const declaration = (t) => !/[=]|\breturn\b|\bnew\b/.test(t) && (
  /^((public|protected|private|abstract|final|static|sealed|non-sealed|export|default|declare)\s+)*(class|interface|enum|record|type)\s+\w+[^;]*\{?$/.test(t)
  || /^((public|protected|private|static|final|default|abstract|synchronized|native|async|override|readonly)\s+)*[\w<>[\],.? ]+\s+\w+\s*\([^)]*\)\s*(throws\s+[\w.,\s]+)?\s*[{;]?$/.test(t)
  || /^((public|protected|private|static|async|override)\s+)*\w+\s*\([^)]*\)\s*(:\s*[\w<>[\]|,.? ]+)?\s*\{$/.test(t)
  || /^[A-Z][A-Z0-9_]*(\([^)]*\))?\s*[,;]?$/.test(t)); // enum constant
const renamedTo = new Set(removed.map((x) => applyRenames(x.line.trim())).filter((x) => x));
const violations = [];
for (const a of added) {
  const t = a.line.trim();
  if (trivial(t) || declaration(t) || MARKER.test(t) || renamedTo.has(t)) continue;
  violations.push(`${a.rel}: + ${t.slice(0, 120)}`);
}
const addedSet = new Set(added.map((x) => x.line.trim()));
// A changed signature (the generated interface gained a parameter) is a removed + an added declaration of the same name.
const declName = (t) => (declaration(t) ? (t.match(/(\w+)\s*\(/) || [])[1] : null);
const addedDecls = new Set(added.map((x) => declName(x.line.trim())).filter(Boolean));
for (const d of removed) {
  const t = d.line.trim();
  if (trivial(t)) continue;
  if (declName(t) && addedDecls.has(declName(t))) continue;
  if (!addedSet.has(applyRenames(t)) || applyRenames(t) === t) violations.push(`${d.rel}: - ${t.slice(0, 120)} (removed without a declared rename)`);
}
console.log(`SYNC VIOLATIONS: ${violations.length}`);
if (violations.length) r.invalid(`the sync added behaviour or changed code beyond compiling — allowed: marker stubs, declarations, imports, declared renames:\n  ${violations.slice(0, 20).join('\n  ')}${violations.length > 20 ? `\n  … ${violations.length - 20} more` : ''}`);
else r.pass(`${added.length} added / ${removed.length} removed production line(s): marker stubs, declarations, imports and declared renames only`);
process.exit(r.finish());
