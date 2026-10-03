---
name: factory
description: Oracul factory orchestrator. Use when the user says "Start new phase development" (with an app idea), invokes /factory, or says "continue" for an Oracul app. Drives one phase end to end — Step 0 setup, Step 1 scope dialog (user approves), Step 2 specs + OpenAPI contract, Step 3 slice plan (user approves), Step 4 test-first slice builds with independent review, Step 5 release with Docker run, E2E, QA pack — through script-checked gates. Builds Java 25 + Spring Boot + Angular Material apps in oracul/apps/.
---

# Oracul factory — orchestrator

You coordinate; specialists do the work. Run from the `oracul/` folder.
Everything you start is multi-agent work that the user asked for by saying "Start new phase development".

## Paths
```
node factory-engine/bin/state.mjs paths --json
```
gives `engine`, `root`, `appDir`, `phase`, `phaseDir` and `workflows.buildSlice` / `workflows.finishAndRun`.
Below, `$E` = engine path, `$APP` = appDir, `$PD` = phaseDir. Agents: subagent types `oracul:analyst`,
`oracul:tester`, `oracul:backend-builder`, `oracul:frontend-builder`, `oracul:reviewer`, `oracul:qa-documenter`
(if the namespaced name is not listed, use the listed name that ends with the role).

## Rules you never break
1. A step is finished only when its command exits 0. Show the real output when it does not.
2. Only the user approves scope and plan. Never stamp approvals yourself — `state.mjs approve` does it after the user said yes.
3. All state changes via `node $E/bin/state.mjs …`; `factory-engine/` is read-only (hook-enforced).
4. You do not write app code or tests yourself — agents do, inside the workflows.
5. Honest end: if anything is red, your final message starts with `❌ RED` and lists what failed.
6. Ask the user only in Step 1 (scope), Step 3 (plan), when the environment check fails, or when a BLOCKED slice stops the phase.

## Start / resume
`node factory-engine/bin/state.mjs show --json`
- **"Start new phase development: <idea>"** and no active app → new app (Step 0, phase 01).
- … and an active app exists → ask once: "Add this as the next phase of `<app>`, or create a new app?"
  - next phase → `node $E/bin/state.mjs phase new <short-name>`, then Step 0 (phase 02+ variant).
  - new app → Step 0 with a new name.
- **"continue"** → resume at the current `step`/`subStep`. Slice IN_PROGRESS: subStep `spec` → from stage `red`;
  `red` → from red-check (Step 4.2); `test-fix`/`green`/`review` → stage `green` with `red: { exitCode: 0, output: "resumed" }`
  (the earlier red-evidence.md is still checked at close).

## Step 0 — setup
New app (derive `<app>` = short kebab-case name from the idea, `<Title>` = readable name; tell the user both):
```
node $E/bin/state.mjs init <app> --title "<Title>"
node $E/bin/state.mjs phase new mvp
node $E/bin/env-check.mjs --write
```
If env-check exits 1: show its table (Item / Found / Fix) and stop until the user says it is fixed; rerun it.
Then (takes several minutes — say so):
```
node $E/bin/scaffold.mjs
node $E/checks/check-artifacts.mjs --step 00_setup
node $E/checks/verify.mjs
node $E/bin/stack.mjs up && node $E/bin/stack.mjs down
node $E/bin/commit.mjs --message "<phase> 00_setup: skeleton"
node $E/bin/state.mjs set step 01_scope
```
Phase 02+ instead: `env-check.mjs --write`, `scaffold.mjs --next-phase`, `verify.mjs` (regression baseline must be GREEN),
`check-artifacts --step 00_setup`, commit, `set step 01_scope`.

## Step 1 — scope (dialog)
Follow the `clarify` skill completely. Exit: user approved, `check-artifacts --step 01_scope` = 0, committed.
Then `node $E/bin/state.mjs set step 02_specs`.

## Step 2 — specs + contract
Agent `oracul:analyst`: "Step 2 for `$APP`, phase docs `$PD`: write the capability specs, contract-notes and extend
api/openapi.yaml for all FRs in `$PD/01_scope/requirements.md`."
Exit: `check-artifacts --step 02_specs` = 0 and `check-contract` = 0 (rerun the analyst with the output if not, max 3 times),
then commit `"<phase> 02_specs: specs + contract"` and `set step 03_plan`.

## Step 3 — plan
Agent `oracul:analyst`: "Step 3: write `$PD/03_plan/plan.md` for this phase."
Check: `check-artifacts --step 03_plan --skip-rule approved` = 0. Show the user the slice table and the graph.
Ask: **"Approve the plan, or tell me what to change."** Changes → analyst updates, show again.
Approved →
```
node $E/bin/state.mjs approve plan
node $E/bin/state.mjs slices-from-plan
node $E/checks/check-artifacts.mjs --step 03_plan
node $E/bin/commit.mjs --message "<phase> 03_plan: plan approved"
node $E/bin/state.mjs set step 04_build
```
Tell the user the build now runs autonomously until the app is running.

## Step 4 — build (one slice at a time)
Loop:
1. `node $E/bin/state.mjs next-slice --json` → `{next, frs, skippedBecauseBlocked}`. `next` = null → Step 5.
2. The slice runs in two workflow stages with red-check between them, which **you** run as a direct command.
   `B` = `scriptPath: <workflows.buildSlice>`, base args `{ engine, root, app, appDir, phase, phaseDir, slice: next, frs }`
   (pass args as a JSON object). If a stage returns `{error}`, the args did not arrive — rerun once; never treat it as a pass.
   1. `B` with `stage: "red"` — analyst spec delta (incl. `Changes earlier behaviour` and `Ranges & invariants` per FR)
      + tester writes the RED tests, updates superseded tests and self-checks them with red-check.
   2. Run it yourself with the Bash tool, foreground, `timeout: 600000` (never through an agent):
      `node $E/bin/red-check.mjs --slice <next>` — it runs Gradle and the Angular tests and takes minutes.
      If the Bash call itself times out, rerun it with `run_in_background: true` and wait for its completion
      notification. A timeout is never a pass; take the exit code from the finished command only.
      Your run is the gate; the tester's own run was only its self-check.
   3. Exit ≠ 0 → once: `B` with `stage: "red"`, `redFeedback: <last 80 lines of the output>`, then red-check again (step 2).
   4. `B` with `stage: "green"`, `red: { exitCode, output: <last 80 lines> }` from the last red-check. With a nonzero
      exitCode it writes the failure note and returns BLOCKED; otherwise builders → verify → E2E → review, up to 5 fix rounds.
      In fix rounds, failures caused by tests and review findings about tests go to the tester; the builders keep the code.
3. Result `DONE` → one-line progress message to the user, continue.
   Result `BLOCKED` with `decision: "CONTINUE"` → tell the user (slice, FRs not delivered, failure note path), continue.
   Result `BLOCKED` with `decision: "STOP"` → stop the phase; report the failure note and the dependent slices; ask the user how to proceed.
4. Slices whose dependency is BLOCKED are skipped (they appear in `skippedBecauseBlocked`); mention them in the final report.

## Step 5 — release
Workflow `scriptPath: <workflows.finishAndRun>`, `args: { engine, root, app, appDir, phase, phaseDir }`.
Then run yourself and show the result: `node $E/checks/check-artifacts.mjs --step 05_release`.

## Final report (to the user)
```
✅ GREEN | ❌ RED — <app> <phase>
Running:  http://localhost:4200  ·  API http://localhost:8080/api   (stop: node factory-engine/bin/stack.mjs down)
FRs:      <n> ✔ · <n> ✘ · <n> BLOCKED     (apps/<app>/docs/<phase>/05_release/qa/traceability.md)
Slices:   01_x DONE · 02_y BLOCKED (failure-note) · …
QA pack:  test-plan.md · acceptance-report.md · how-to-run.md · screenshots/
Problems: <none | list>
```
