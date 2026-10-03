#!/usr/bin/env node
// PreToolUse guard (Edit|Write|MultiEdit|NotebookEdit|Bash). Blocks with exit 2:
//   - any write into factory-engine/** (state changes go through `node factory-engine/bin/state.mjs`)
//   - edits of generated code (frontend/src/app/api/**, backend/build/**)
//   - subStep red:    production code (tester writes tests only)
//   - subStep test-fix: production code and api/openapi.yaml (tester repairs tests in a fix round)
//   - subStep green:  tests and api/openapi.yaml (builders never change tests or the contract)
//   - subStep review: anything outside docs/ (reviewer only reports)
import path from 'node:path';
import { active, block, inside, isEngine, kind, readInput } from './lib.mjs';

const input = readInput();
const tool = input.tool_name;
const ti = input.tool_input || {};
const cwd = input.cwd || process.cwd();

if (tool === 'Bash') {
  // Reading from the engine (templates, checks) is fine; writing into it is not.
  const c = String(ti.command || '');
  const isEng = (tok) => {
    const t = tok.replace(/^["']|["']$/g, '');
    return /(^|\/)factory-engine(\/|$)/.test(t) && isEngine(path.resolve(cwd, t)) || isEngine(t);
  };
  const deny = () => block('factory-engine is read-only while building apps. Change state only with `node factory-engine/bin/state.mjs …`.');
  for (const m of c.matchAll(/>>?\s*(\S+)/g)) if (isEng(m[1])) deny();
  for (const seg of c.split(/&&|\|\||[|;&]/)) {
    const tok = seg.trim().split(/\s+/).filter(Boolean);
    const args = tok.slice(1).filter((t) => !t.startsWith('-'));
    if (!tok.length || !args.length) continue;
    if (['cp', 'mv', 'ln', 'install', 'rsync'].includes(tok[0]) && isEng(args.at(-1))) deny();
    if (['rm', 'rmdir', 'touch', 'truncate', 'chmod', 'mkdir', 'tee', 'unlink'].includes(tok[0]) && args.some(isEng)) deny();
    if (tok[0] === 'sed' && tok.includes('-i') && isEng(args.at(-1))) deny();
    if (tok[0] === 'mv' && args.slice(0, -1).some(isEng)) deny();
  }
  process.exit(0);
}

const raw = ti.file_path || ti.notebook_path;
if (!raw) process.exit(0);
const file = path.resolve(cwd, raw);

if (isEngine(file)) block(`${raw}: factory-engine is read-only while building apps. Use \`node factory-engine/bin/state.mjs …\` for state; improve the factory in a separate session started inside factory-engine/.`);

const a = active();
if (!a || !inside(file, a.appDir)) process.exit(0);
const rel = path.relative(a.appDir, file).split(path.sep).join('/');
const k = kind(rel);
const sub = a.state.subStep;

if (k === 'generated') block(`${rel} is generated from api/openapi.yaml — change the contract, never the generated code.`);
if (sub === 'red' && k === 'prod') block(`${rel}: RED phase — only tests may be written now. Production code comes in the GREEN phase.`);
if (sub === 'test-fix' && (k === 'prod' || k === 'contract')) block(`${rel}: TEST-FIX round — the tester repairs tests only. Production code belongs to the builders, the contract to the analyst.`);
if (sub === 'green' && k === 'test') block(`${rel}: GREEN phase — tests are locked. Make the existing tests pass; never edit a test to pass it.`);
if (sub === 'green' && k === 'contract') block('api/openapi.yaml is locked during GREEN. Contract changes belong to the spec step (analyst).');
if (sub === 'review' && k !== 'docs') block(`${rel}: REVIEW phase — the reviewer reports findings in review-findings.json and never edits code.`);
process.exit(0);
