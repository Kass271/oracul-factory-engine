#!/usr/bin/env node
// Record the app's working tree as a git tree object — no commit, no change to the index or HEAD — so the next review
// can look at exactly what changed since this one (`git diff <tree>`).
//   (no args)   write a snapshot, print "TREE <id>"; state/apps/<app>/review-snapshot.json keeps { slice, tree, at }
//   --show      print the last snapshot's tree for the current slice ("TREE <id>" or "TREE none")
//   --diff      print what changed since the last snapshot (git diff <last tree> <current tree>; untracked files
//               included) — the reviewer's delta. The current tree is not recorded.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { STATE_DIR, context, parseArgs, readJson, run, writeJson } from '../checks/lib/core.mjs';

const args = parseArgs();
const ctx = context(args);
if (!ctx.appDir || !ctx.app) { console.error('snapshot: no active app'); process.exit(1); }
const file = path.join(STATE_DIR, 'apps', ctx.app, 'review-snapshot.json');
function treeNow() {
  const idx = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oracul-snap-')), 'index');
  const env = { ...process.env, GIT_INDEX_FILE: idx };
  const add = run('git', ['-C', ctx.appDir, 'add', '-A'], { env });
  const tree = add.code === 0 ? run('git', ['-C', ctx.appDir, 'write-tree'], { env }) : add;
  fs.rmSync(path.dirname(idx), { recursive: true, force: true });
  if (tree.code !== 0) { console.error(`snapshot: git failed — ${tree.out.trim()}`); process.exit(1); }
  return tree.out.trim();
}
if (args.diff) {
  const s = readJson(file);
  if (!s || s.slice !== ctx.state?.slice) { console.log('no earlier snapshot for this slice — review the whole slice'); process.exit(0); }
  const d = run('git', ['-C', ctx.appDir, 'diff', '--stat', '--patch', s.tree, treeNow()]);
  console.log(d.out.trim() || 'no changes since the last review');
  process.exit(0);
}
if (args.show) {
  const s = readJson(file);
  console.log(`TREE ${s && s.slice === ctx.state?.slice ? s.tree : 'none'}`);
  process.exit(0);
}
const tree = treeNow();
writeJson(file, { slice: ctx.state?.slice ?? null, tree, at: new Date().toISOString() });
console.log(`TREE ${tree}`);
