#!/usr/bin/env node
// Stop: honest ending. While building (04_build / 05_release), the session may not end on a RED or stale verify
// without saying so. Block ONCE (exit 2); on the second attempt (stop_hook_active) allow — the final message must
// then start with "❌ RED" and list the failing checks. Dialog steps (scope/plan) are never blocked.
import fs from 'node:fs';
import path from 'node:path';
import { walk } from '../checks/lib/core.mjs';
import { active, readInput } from './lib.mjs';

const input = readInput();
const a = active();
if (!a || input.stop_hook_active) process.exit(0);
const { step, lastVerify } = a.state;
if (!['04_build', '05_release'].includes(step)) process.exit(0);

let reason = null;
if (!lastVerify) reason = 'verify has never run for this app';
else if (lastVerify.result !== 'GREEN') reason = `last verify is RED: ${(lastVerify.failing || []).join(', ')}`;
else {
  const at = Date.parse(lastVerify.at);
  const changed = ['backend/src', 'frontend/src', 'e2e/tests', 'api']
    .flatMap((d) => walk(path.join(a.appDir, d), (p) => !p.includes(`${path.sep}app${path.sep}api${path.sep}`)))
    .find((p) => fs.statSync(p).mtimeMs > at);
  if (changed) reason = `code changed after the last verify (${path.relative(a.appDir, changed)})`;
}
if (!reason) process.exit(0);

process.stderr.write(`[oracul] Not finished: ${reason}.
Run: node factory-engine/checks/verify.mjs  — then fix what is red.
If you cannot make it green now, you may stop, but your final message MUST start with "❌ RED" and list the failing checks.\n`);
process.exit(2);
