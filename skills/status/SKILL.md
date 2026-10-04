---
name: status
description: Oracul dashboard — shows the active app, phase, step, slices, approvals, last verify and missing artifacts. Use when the user asks "status", "where are we", "what is missing".
---

# Status

Run from `oracul/` (read-only; changes nothing):
```
node factory-engine/bin/state.mjs show
node factory-engine/bin/state.mjs timings
node factory-engine/bin/state.mjs flaky
node factory-engine/checks/verify.mjs --quick
```
For the current step also run `node factory-engine/checks/check-artifacts.mjs --step <step>` (add `--skip-rule approved`
while an approval is pending).

Answer with a compact dashboard:
```
App <app> · <phase> · Step <step> (<subStep>) · slice <slice> round <n>
Slices   01_x DONE · 02_y IN_PROGRESS · 03_z PENDING · 04_w BLOCKED
Approvals scope ✔ <date> · plan ✔ <date>
Verify   GREEN|RED (<failing checks>) — quick run, reports from <last full run>
Time     <slice>: <total> — <subStep> <time> · …   (current and last slice, from `state.mjs timings`)
Flaky    <tests that passed only on retry, PERSISTENT first, or "none">
Missing  <MISSING/INVALID lines, or "none">
Next     <the next action of the factory>
```
`--quick` reuses existing test reports; say so. For a full run: `node factory-engine/checks/verify.mjs`.
