#!/usr/bin/env node
// The gate ledger of the active app (checks/lib/inputs.mjs): which gate is green on the CURRENT inputs.
//   status [--json]   backend, frontend and every E2E spec: green (current) · stale (inputs changed / not a full run) ·
//                     red · never.   Exit 0 = every gate green on the current inputs, 1 = not.
import { context, parseArgs } from '../checks/lib/core.mjs';
import { allGates, gateState } from '../checks/lib/inputs.mjs';

const args = parseArgs();
const ctx = context(args);
if (!ctx.appDir || !ctx.app) { console.error('gates: no active app'); process.exit(1); }
const { groups, gates } = allGates(ctx.appDir);
const rows = gates.map((g) => ({ gate: g, ...gateState(ctx.appDir, ctx.app, g, groups) }));
if (args.json) console.log(JSON.stringify(rows));
else for (const r of rows) console.log(`${r.state.padEnd(6)} ${r.gate}${r.at ? ` (${r.at})` : ''}${r.why ? ` — ${r.why}` : ''}`);
const notGreen = rows.filter((r) => r.state !== 'green');
console.log(notGreen.length ? `GATES NOT GREEN: ${notGreen.length} of ${rows.length}` : `ALL ${rows.length} GATES GREEN on the current inputs`);
process.exit(notGreen.length ? 1 : 0);
