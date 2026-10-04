#!/usr/bin/env node
// Rule: the Docker stack the factory starts is unambiguous. Either plain docker-compose.yml and nothing else, or
// .oracul/stack.json declares the modes (e2e = what the factory's E2E runs against, run = what the user starts) and
// every file it names exists. Extra compose files without the config → INVALID (stack.mjs would refuse them too).
import { Report, context, parseArgs } from './lib/core.mjs';
import { STACK_CONFIG, extraComposeFiles, loadStackConfig } from './lib/stack.mjs';

const args = parseArgs();
const ctx = context(args);
const r = new Report('stack');
if (!ctx.appDir) { r.invalid('no app selected'); process.exit(r.finish()); }
const { config, problems } = loadStackConfig(ctx.appDir);
const extra = extraComposeFiles(ctx.appDir);
if (problems.length) problems.forEach((p) => r.invalid(p));
else if (config) r.pass(`${STACK_CONFIG}: modes ${Object.keys(config.modes).join(', ')}`);
else if (extra.length) r.invalid(`extra compose file(s) ${extra.join(', ')} but no ${STACK_CONFIG} — declare which stack E2E (mode e2e) and the user (mode run) start`);
else r.pass('plain docker-compose.yml (no stack modes needed)');
process.exit(r.finish());
