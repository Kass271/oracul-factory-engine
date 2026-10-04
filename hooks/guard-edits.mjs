#!/usr/bin/env node
// PreToolUse guard (Edit|Write|MultiEdit|NotebookEdit|Bash). Blocks with exit 2:
//   - any write into factory-engine/** (state changes go through `node factory-engine/bin/state.mjs`)
//   - edits of generated code (frontend/src/app/api/**, backend/build/**)
//   - subStep sync:   tests and api/openapi.yaml (builders only make production code compile after a contract change;
//                     checks/check-sync.mjs proves they added no behaviour)
//   - subStep red:    production code (tester writes tests only)
//   - subStep test-fix: production code and api/openapi.yaml (tester repairs tests in a fix round)
//   - subStep green:  tests and api/openapi.yaml (builders never change tests or the contract)
//   - subStep review: anything outside docs/ (reviewer only reports)
//   - Bash, any subStep while an app is active: running Playwright directly (npx/pnpx/bunx, yarn/pnpm [exec],
//     npm exec/x, node_modules/.bin, node …/cli.js, npm run/test in e2e/) or changing the Docker stack directly
//     (docker compose up/down/…, docker stop/rm/…). E2E and the stack run only through stack.mjs (lock, evidence dirs).
//   - Bash in subSteps red/green/test-fix/review: stack.mjs up/down/e2e too — E2E runs only in the workflow's E2E step
//     (subStep e2e); the one exception is the tester's scoped scratch run in test-fix:
//     `stack.mjs e2e --scratch --grep <pattern>`. Reading/searching, unit tests, `stack.mjs status`, `docker compose
//     ps|logs` and installing packages stay allowed.
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
  const a = active();
  if (a) {
    const why = stackViolation(c, cwd, a.state.subStep);
    if (why) block(`${why}: E2E and the Docker stack run only through stack.mjs — the official E2E only in the workflow's E2E step (subStep e2e). In a test-fix round the tester may verify a repair with: node <engine>/bin/stack.mjs e2e --scratch --grep <spec file>. If stack.mjs refused a run, report its reason and stop — never run Playwright or docker compose yourself.`);
  }
  process.exit(0);
}

// First reason a command would run Playwright or change the Docker stack outside the lock, else null.
// Each segment is judged in the subStep it will run in: `state.mjs set subStep e2e && stack.mjs e2e` (the workflow's
// own E2E step) is allowed, because the hook runs before the command and still sees the previous subStep.
function stackViolation(command, startDir, startSub) {
  const LOCKED_OUT = ['sync', 'red', 'green', 'test-fix', 'review'];
  let dir = startDir;
  let sub = startSub;
  for (const seg of command.split(/&&|\|\||[|;&\n]/)) {
    let tok = seg.trim().split(/\s+/).filter(Boolean).map((t) => t.replace(/^["']|["']$/g, ''));
    while (tok.length && (/^\w+=/.test(tok[0]) || tok[0] === 'env' || tok[0] === 'exec' || tok[0] === 'time')) tok = tok.slice(1);
    if (tok[0] === 'timeout') tok = tok.slice(1).filter((t, i) => i > 0 || !/^\d/.test(t));
    if (!tok.length) continue;
    const [c0, c1] = tok;
    if (c0 === 'cd') { dir = path.resolve(dir, tok[1] || '.'); continue; }
    const si = tok.findIndex((t) => /(^|\/)state\.mjs$/.test(t));
    if (si >= 0 && tok[si + 1] === 'set' && tok[si + 2] === 'subStep' && tok[si + 3]) { sub = tok[si + 3]; continue; }
    const locked = LOCKED_OUT.includes(sub);
    // Playwright started directly — in every subStep (stack.mjs starts it as a child process, never as a tool call).
    const pkgRunner = ['npx', 'pnpx', 'bunx', 'yarn', 'pnpm', 'node'].includes(c0) || (c0 === 'npm' && ['exec', 'x'].includes(c1));
    const pw = tok.findIndex((t) => /(^|\/)playwright(@[\w.^~-]+)?$/.test(t) || /(^|\/)(@playwright\/test|playwright(-core)?)\/cli\.js$/.test(t));
    if (pw >= 0 && (pw === 0 || pkgRunner)) {
      const verb = tok.slice(pw + 1).find((t) => !t.startsWith('-'));
      if (verb === 'test' || (verb === 'install' && locked)) return `\`${seg.trim()}\` runs Playwright`;
    }
    const pi = tok.findIndex((t) => t === '--prefix' || t.startsWith('--prefix='));
    const prefix = pi < 0 ? null : tok[pi].includes('=') ? tok[pi].split('=')[1] : tok[pi + 1];
    const npmCmd = c0 === 'npm' && tok.slice(1).find((t, i) => !t.startsWith('-') && !(pi >= 0 && !tok[pi].includes('=') && i + 1 === pi + 1));
    if (c0 === 'npm' && ['run', 'run-script', 'test', 't', 'start', 'exec', 'x'].includes(npmCmd)) {
      if ((prefix && /(^|\/)e2e\/?$/.test(prefix)) || (!prefix && /(^|\/)e2e$/.test(dir))) return `\`${seg.trim()}\` runs the E2E package`;
    }
    // The Docker stack changed directly — in every subStep (stack.mjs up/down hold the lock).
    const compose = c0 === 'docker-compose' ? tok.slice(1) : c0 === 'docker' && c1 === 'compose' ? tok.slice(2) : null;
    if (compose && compose.some((t) => ['up', 'down', 'build', 'restart', 'rm', 'stop', 'start', 'kill', 'create', 'run'].includes(t))) return `\`${seg.trim()}\` changes the Docker stack`;
    if (c0 === 'docker' && ['stop', 'rm', 'kill', 'restart', 'start', 'run'].includes(c1)) return `\`${seg.trim()}\` changes Docker containers`;
    if (!locked) continue;
    const st = tok.findIndex((t) => /(^|\/)stack\.mjs$/.test(t));
    if (st >= 0) {
      const rest = tok.slice(st + 1);
      const action = rest.find((t) => !t.startsWith('-'));
      if (!['up', 'down', 'e2e'].includes(action)) continue;
      const gi = rest.indexOf('--grep');
      const grep = gi >= 0 ? rest[gi + 1] : rest.find((t) => t.startsWith('--grep='))?.slice(7);
      const scoped = action === 'e2e' && rest.includes('--scratch') && grep && !grep.startsWith('-');
      if (scoped && sub === 'test-fix') continue;
      return `\`${seg.trim()}\` ${scoped ? 'is a scratch run outside test-fix' : action === 'e2e' && rest.includes('--scratch') ? 'is a scratch run without --grep' : 'is a stack operation'}`;
    }
  }
  return null;
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
if (sub === 'sync' && (k === 'test' || k === 'contract')) block(`${rel}: CONTRACT SYNC — only production code may change, and only to compile again (marker stubs, declared renames). Tests belong to the tester, the contract to the analyst.`);
if (sub === 'red' && k === 'prod') block(`${rel}: RED phase — only tests may be written now. Production code comes in the GREEN phase.`);
if (sub === 'test-fix' && (k === 'prod' || k === 'contract')) block(`${rel}: TEST-FIX round — the tester repairs tests only. Production code belongs to the builders, the contract to the analyst.`);
if (sub === 'green' && k === 'test') block(`${rel}: GREEN phase — tests are locked. Make the existing tests pass; never edit a test to pass it.`);
if (sub === 'green' && k === 'contract') block('api/openapi.yaml is locked during GREEN. Contract changes belong to the spec step (analyst).');
if (sub === 'review' && k !== 'docs') block(`${rel}: REVIEW phase — the reviewer reports findings in review-findings.json and never edits code.`);
process.exit(0);
