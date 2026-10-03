#!/usr/bin/env node
// PostToolUse (Edit|Write|MultiEdit) inside the active app — immediate feedback per edit:
//   frontend *.ts|*.html|*.scss → prettier --write <file>
//   backend  *.java             → gradlew compileJava compileTestJava (one at a time; errors go back to the agent)
// Exit 2 only to report compile errors (the edit itself already happened).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, tail } from '../checks/lib/core.mjs';
import { active, inside, readInput } from './lib.mjs';

const input = readInput();
const raw = input.tool_input?.file_path;
const a = active();
if (!raw || !a) process.exit(0);
const file = path.resolve(input.cwd || process.cwd(), raw);
if (!inside(file, a.appDir) || !fs.existsSync(file)) process.exit(0);
const rel = path.relative(a.appDir, file).split(path.sep).join('/');

if (/^frontend\/src\/.*\.(ts|html|scss)$/.test(rel) && !rel.startsWith('frontend/src/app/api/')) {
  const fe = path.join(a.appDir, 'frontend');
  if (fs.existsSync(path.join(fe, 'node_modules', '.bin', 'prettier'))) run('npx', ['--no-install', 'prettier', '--write', file], { cwd: fe });
  process.exit(0);
}

if (/^backend\/src\/.*\.java$/.test(rel)) {
  const be = path.join(a.appDir, 'backend');
  const lock = path.join(os.tmpdir(), `oracul-compile-${a.app}.lock`);
  try {
    if (fs.existsSync(lock) && Date.now() - fs.statSync(lock).mtimeMs < 150_000) process.exit(0); // another compile running
    fs.writeFileSync(lock, String(process.pid));
    const r = run('./gradlew', ['compileJava', 'compileTestJava', '-q', '--console=plain'], { cwd: be, timeout: 170_000 });
    if (r.code !== 0) {
      const errors = r.out.split('\n').filter((l) => /error:|warning: \[|FAILED|\.java:\d+/.test(l)).slice(0, 30).join('\n');
      process.stderr.write(`[oracul] backend does not compile after editing ${rel}:\n${errors || tail(r.out, 30)}\n`);
      process.exit(2);
    }
  } finally {
    fs.rmSync(lock, { force: true });
  }
}
process.exit(0);
