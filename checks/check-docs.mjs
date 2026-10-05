#!/usr/bin/env node
// Rule: shell commands in docs are at least syntactically valid — a cheap check (seconds) before any expensive gate.
// For changed *.md files: every ```bash|sh|zsh|shell block is checked with `bash -n` (and `zsh -n` when zsh exists);
// changed *.sh files the same. Syntax only: a command that parses but does the wrong thing is the README test's job
// (testing-rules → "Checks of documents").
//   --files a.md,b.sh   check these files (default: the changed *.md / *.sh in the working tree)
// Exit 0 = PASS (or nothing to check) · 1 = a block or script does not parse.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Report, context, parseArgs, run } from './lib/core.mjs';
import { changedFiles } from './lib/related.mjs';

const args = parseArgs();
const ctx = context(args);
const r = new Report('docs (shell syntax)');
if (!ctx.appDir) { r.invalid('no app selected'); process.exit(r.finish()); }
const files = (typeof args.files === 'string' ? args.files.split(',') : changedFiles(ctx.appDir)).filter((f) => /\.(md|sh)$/i.test(f) && fs.existsSync(path.join(ctx.appDir, f)));
const shells = ['bash', ...(run('sh', ['-c', 'command -v zsh']).code === 0 ? ['zsh'] : [])];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oracul-docs-'));
let blocks = 0;
const check = (label, code) => {
  blocks++;
  const f = path.join(tmp, `b${blocks}.sh`);
  fs.writeFileSync(f, code);
  for (const sh of shells) {
    const x = run(sh, ['-n', f]);
    if (x.code !== 0) { r.invalid(`${label}: ${sh} -n — ${x.out.replace(new RegExp(f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), 'block').trim().split('\n')[0]}`); return; }
  }
};
for (const rel of files) {
  const text = fs.readFileSync(path.join(ctx.appDir, rel), 'utf8');
  if (/\.sh$/i.test(rel)) { check(rel, text); continue; }
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(/^\s*(`{3,}|~{3,})\s*(bash|sh|zsh|shell)\b/i);
    if (!open) continue;
    const body = [];
    let j = i + 1;
    for (; j < lines.length && !lines[j].trim().startsWith(open[1]); j++) body.push(lines[j]);
    check(`${rel}:${i + 1}`, body.join('\n'));
    i = j;
  }
}
fs.rmSync(tmp, { recursive: true, force: true });
if (!r.bad) r.pass(blocks ? `${blocks} shell block(s)/script(s) in ${files.length} file(s) parse (${shells.join(', ')} -n)` : 'no changed doc with shell blocks');
process.exit(r.finish());
