#!/usr/bin/env node
// Rule: the last official full E2E run (stack.mjs, recorded in state/apps/<app>/e2e-last.json) passed AND tested exactly
// the current code — same hash of the image inputs and of the E2E package (checks/lib/hash.mjs). The slice gate: a
// slice closes only with a full green E2E run on its final code; the workflows also use it to skip a full run that
// would test nothing new (Step 5 after the last slice).
//   --allow-missing   no record at all (an app built before the record existed) → WARN, exit 0
// Exit 0 = fresh · 1 = stale, failed or missing.
import { Report, context, e2eLastPath, parseArgs, readJson } from './lib/core.mjs';
import { e2eInputsHash } from './lib/hash.mjs';

const args = parseArgs();
const ctx = context(args);
const r = new Report('e2e fresh');
if (!ctx.appDir || !ctx.app) { r.invalid('no app selected'); process.exit(r.finish()); }
const rec = readJson(e2eLastPath(ctx.app));
if (!rec) {
  if (args['allow-missing']) r.warn('no full E2E run recorded (app built before e2e-last.json existed) — not checked');
  else r.missing('no full E2E run recorded — run the official E2E');
} else if (rec.code !== 0) r.invalid(`the last full E2E run (${rec.at}) failed`);
else if (rec.hash !== e2eInputsHash(ctx.appDir)) r.invalid(`code changed since the last full E2E run (${rec.at}) — it does not cover the current code`);
else r.pass(`the last full E2E run (${rec.at}) passed on exactly this code`);
process.exit(r.finish());
