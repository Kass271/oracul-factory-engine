# Oracul factory — round 3 (F1–F7)

Status: **WAITING — implement only when the user says so.** Written 2026-10-04 after slice 03 of oracul-engine
(253 min; ~48 of 91 green-stage minutes in E2E; issues list: oracul/docs/for-factory-improvements/issues-phase-02-session-3.md).
Out of scope here: F8 (E2E check in red — later, WARN-first trial), F9 (parallel docs agents — needs per-agent guard
rules), parallel slices (see the analysis at the end).

## Rules for this round
1. Implement in a git worktree on branch `round-3`; main (loaded by the app session) changes only at the merge.
2. No new subSteps, no renamed state fields, no doc-format changes except the additive ones named here.
3. Never weaken a check: every item has a red and a green self-test case; `node self-test/run.mjs` → N/N after each.
4. Merge only between slices (app at subStep `none`, no `stack.lock`), after self-test and smoke are green.

## F1 — skip the focus E2E run when it covers most of the suite
**Why:** slice 03 round 2: focus run 8.3 min, then the full run repeated the same specs.
**Change:** `stack.mjs e2e --focus-slice` counts the spec files under `e2e/tests`; if the focus list covers ≥ 50 % of
them (`FOCUS_MAX_SHARE` constant), it prints `FOCUS TOO BROAD (n of m specs) — run the full E2E` and exits 6 — the
exit the workflows already treat as "go straight to the full official run". No workflow change.
**Self-test:** 3 of 4 specs in focus → exit 6, no lock taken (red for the focus path); 1 of 4 → focus list (green);
existing workflow case for exit 6 still passes (green).
**Risk:** threshold too low/high → only time, never correctness (the full run stays the gate).

## F2 — the contract must parse, checked at the spec gate
**Why:** an unquoted YAML value with ": " passed `check-artifacts --stage spec` and `check-contract`; both generators
failed later in sync (issue 1, ~18 min detour).
**Change:** `check-contract --validate` runs the real generators — backend `./gradlew -q openApiGenerate`, frontend
`npm run generate:api --silent` (when the layer exists) — and reports their first error lines. Runs only when
`api/openapi.yaml` changed since the last finished slice (`contractChanged`, checks/lib/compile.mjs); otherwise
`SKIP contract unchanged`. Wired into: the Step 2 exit (`skills/factory` Step 2), the slice spec gate (manifest item
`api/openapi.yaml` rule `contractParses`, stage `spec`), and the analyst's "done when". Self-test seam
`ORACUL_GENERATE_FAKE`.
**Self-test:** generator fails → INVALID with its message (red); passes → PASS (green); contract unchanged → SKIP,
no generator call (green); no backend dir → WARN skip (green).
**Risk:** +10–20 s per changed-contract spec check; existing apps are only checked on a change (no mid-phase block).

## F3 — a sync stop caused by an invalid contract goes back to the analyst
**Why:** repairing issue 1 needed a manual `state.mjs set subStep spec` (issue 2).
**Change:** `contractSync()` (build-slice stage red) first runs `check-contract --validate`. Invalid →
`set subStep spec` → analyst repair with the generator output (docs + contract only) → validate again → still
invalid → STOPPED `sync: contract invalid` (as today). At most **one** analyst repair; compile errors keep going to the
builders as now.
**Self-test (workflow stubs):** validate fails then passes → analyst repair before any sync builder (green); fails
twice → STOPPED, no builder, no tester (red); validate passes → no analyst call (green); replay: every command passes
the guard (green).
**Risk:** a loop or a weakened contract — capped at one repair; the spec gate and check-contract still apply.

## F4 — check-sync accepts "required → optional" constructor moves
**Why:** making `RecentRunSummary.headline` optional changed the generated constructor; the builder moved the value
to `.headline(…)`; check-sync rejected it on every rerun (issue 3).
**Change:** check-sync reads the fields that lost `required` since the green base (`git show <base>:api/openapi.yaml`
vs now; `requiredSet()` added to checks/lib/openapi.mjs). A removed `new X(a, b, c)` + added `new X(a, c).f(b)` (same
line or the following chain lines) is accepted only if X has a field that lost `required`, every setter `f` is such a
field (camelCase), and the moved argument expressions are exactly the removed ones. Everything else stays rejected.
**Self-test:** contract lost `required: headline` + move → PASS (green); the same move without a contract change →
INVALID (red); a setter with a different value → INVALID (red); a setter for a field that is still required →
INVALID (red).
**Risk:** a weaker sync check — mitigated by the four-condition match and the red cases.

## F5 — the release reuses the last full verify's test run
**Why:** the release repeats ~10 min of tests on code that the last slice close already verified (issue 4).
**Change:** `verify --reuse-tests-if-fresh`: when the last verify was full, GREEN and nothing it measured changed
(the existing staleness check), the test layers are skipped (printed: `tests reused from <at>`) but **all checks run**
with the given scope; otherwise a normal full run. `lastVerify` records `reusedFrom` (additive). finish-and-run's
first verify uses `--scope all --reuse-tests-if-fresh`; fix rounds run the full verify as now.
**Self-test:** fresh → layers skipped, checks run, scope all honoured (green); stale (source newer) → full run (red
in the sandbox); `--reuse-if-fresh` never accepts a `reusedFrom` verify as a fresh full run unless its tests were
fresh (green/red pair); workflow: release calls verify with the flag (green).
**Risk:** reusing stale results — same staleness rules as the slice close, which smoke already proves.

## F6 — suite health warnings (never blocking)
**Why:** 111 Spring context starts, 63-s near-duplicate classes and a serial 169-test E2E suite grew unnoticed.
**Change:** verify prints `WARN suite:` lines when Spring context starts > 20, a test class > 60 s, or
`e2e/playwright.config.ts` has `workers: 1` with > 50 E2E tests (from the last official report). Values are stored in
`state/apps/<app>/suite-health.json` and printed as `now (was …)`. Exit code unchanged. The reviewer prompt: suite
health warnings are low severity unless the slice made them worse.
**Self-test:** 25 contexts → WARN, exit unchanged (green); 5 contexts → no WARN (green); workers 1 + 60 tests →
WARN (green); "was" value printed after a second run (green); a WARN never turns verify RED (red case for the
opposite).
**Risk:** reviewer noise — low severity by rule.

## F7 — slice-size guard in Step 3
**Why:** slice 03 had 6 FRs and many rewritten older tests (253 min).
**Change:** check-artifacts gets warn support (a rule may return `{ warn }`); new rule `planSliceSize` on
`03_plan/plan.md`: WARN for a slice with more than 3 FRs, only while `step` is `03_plan` (approved plans are never
re-checked). The analyst's Step 3: prefer ≤ 3 FRs per slice, split larger ones; the orchestrator shows the WARN lines
with the plan and the user decides.
**Self-test:** 4-FR slice at step 03_plan → WARN, exit 0 (green); at step 04_build → no WARN (green); 2-FR slices →
no WARN (green); an INVALID elsewhere still fails (red).
**Risk:** more, smaller slices → a little more per-slice overhead; WARN only, the user decides.

## Order, verification, merge
Order: F1 → F2 → F3 → F4 → F5 → F6 → F7, one commit each (`R1: …` … `R7: …`). Then `node self-test/smoke.mjs` with
two new steps (contract validation on the real generators; release verify reusing the close's tests). Bump the plugin
version. Merge (fast-forward) only between slices; restart the app session afterwards.

## Risks (summary)
| Item | Changes the flow? | Risk | Mitigation |
|---|---|---|---|
| F1 | no | threshold off → time only | constant, timings show it, full run stays the gate |
| F2 | no | +10–20 s; stricter than before | only on a changed contract; skip without backend |
| F3 | slightly (route inside stage red) | loop / weakened contract | one repair, then STOPPED; gates unchanged |
| F4 | no | weaker sync check | four-condition match, red cases |
| F5 | no | stale reuse | the existing staleness rules |
| F6 | no | reviewer noise | WARN only, low severity |
| F7 | slightly (plan may be split) | more slices | WARN only, new plans only |

## Analysis: run independent slices in parallel?
**Idea:** at Step 4, slices whose dependencies are all DONE (e.g. two slices that both depend only on 01) are built at
the same time.

**What it would need**
- **One working tree per slice** (git worktrees) — today all agents share one tree; two slices would mix their diffs,
  and red-check/verify of one would see the other's unfinished code.
- **State per slice** — `state.json` has one `slice` and one `subStep`; the guard decides write rights from that one
  subStep. It would need per-worktree state and a hook that maps the edited file's worktree to its slice.
- **Merging** — both slices change shared files (routes, `api/openapi.yaml` in their spec deltas, the README); the
  second merge needs conflict resolution, then a full verify + full E2E again on the merged result.
- **One Docker stack** — fixed ports 4200/8080 and the stack lock serialise every E2E run. E2E is the biggest cost
  (~20 min per full run today), so the two slices would wait for each other there anyway.

**Gain:** only the agent time overlaps (analyst, tester, builders ≈ 40–60 % of a slice). With E2E serialised and a
merge re-verification, a realistic gain is ~20–30 % on a phase with many independent slices — and nothing when the
plan is a chain (most plans are).

**Risk:** high — new state model, new guard model, merge conflicts on the contract, two concurrent stacks or a longer
queue on one. It touches every hard guarantee (role guards, red-before-green, one gate per slice).

**Recommendation:** not now. The same time is won more safely by (1) the app-side suite work (parallel E2E workers,
one Spring context: ~20 → ~5 min and ~9.5 → ~4 min per full round), (2) F1–F7, and (3) smaller slices (F7). Revisit
parallel slices only if, after those, agent time dominates and plans have many independent slices.

## Run prompt (factory session, between slices)
```
Implement plans/2026-10-04-factory-round-3.md (F1–F7) with automerge.
App paused: yes
1. Read AGENTS.md and the plan. Worktree: git worktree add ../factory-engine-r3 -b round-3 main. Work only there;
   never touch ../apps/ or state/.
2. One commit per item in the order F1…F7 ("R<n>: <what>"), each with its red + green self-test cases;
   node self-test/run.mjs must print N/N before each commit. Never weaken a check.
3. Add the two smoke steps, run node bin/env-check.mjs, then node self-test/smoke.mjs. Bump the plugin version.
4. Automerge only if: self-test N/N, smoke green, "App paused: yes", app at subStep none, no state/apps/*/stack.lock.
   If main moved, rebase and re-test first. git merge --ff-only round-3 in the main checkout, self-test there;
   on failure reset to the pre-merge commit and report. Remove the worktree, keep the branch.
5. Report: commits, self-test count, smoke result, merged yes/no, and: restart the app session, then "continue".
```
