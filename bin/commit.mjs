#!/usr/bin/env node
// Local commit in the active app's repo (never pushes). Message convention:
//   "<phase> <step|slice>: <summary> [FR-1, FR-2]"
//   --message "<text>"
import { context, parseArgs, run } from '../checks/lib/core.mjs';

const args = parseArgs();
const ctx = context(args);
if (!ctx.appDir || !args.message) { console.error('commit: --message and an active app are required'); process.exit(1); }
const git = (...a) => run('git', a, { cwd: ctx.appDir });

const hasUser = git('config', 'user.email').out.trim();
const id = hasUser ? [] : ['-c', 'user.name=Oracul Factory', '-c', 'user.email=factory@oracul.local'];
git('add', '-A');
if (git('diff', '--cached', '--quiet').code === 0) { console.log('nothing to commit'); process.exit(0); }
const r = git(...id, 'commit', '-q', '-m', args.message);
if (r.code) { console.error(r.out); process.exit(1); }
console.log(`committed ${git('rev-parse', '--short', 'HEAD').out.trim()}: ${args.message}`);
