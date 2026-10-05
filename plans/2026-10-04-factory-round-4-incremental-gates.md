# Oracul factory — round 4: incremental gates ("green stays green")

Status: **WAITING — implement only when the user says so.** Written 2026-10-04 from the app session's request
(`oracul/docs/for-factory-improvements/prompt-incremental-gates.md`, issues 11–13 of `issues-phase-02-session-3.md`).
Related: `plans/2026-10-04-factory-round-3.md` (F1–F7) — see "Relation to round 3" at the end.
Revised 2026-10-05 after `retro-slice-03.md`, `slice-retro-diagnostics.md` and the session-2 list: G4 reads E2E results
from the ledger instead of rewriting Playwright's report and handles project `dependencies`; G6 adds a hardening
backlog; G9 becomes the user's **takeover after round 3** with a deterministic close command (G11); slice retro and
interventions log added (D1, D2).

## Goal
A fix round re-runs only the gates whose inputs changed. A gate that went green on inputs X stays green while X is
unchanged. The slice close still needs **every** gate green on the **current** inputs — proven by a ledger, not by
re-running everything every round.

## Evidence (oracul-engine phase-02, slice 03_run-modes-readme, 2026-10-04)
- Round 4 fixed one README line (`((cd …))` → `(cd …)`) and cost ~45 min: both builders, full verify (~8 min),
  Docker rebuild, focus E2E (7.6 min, 72 specs), full E2E (~20 min, ~156 specs), full review.
- Cause 1, `checks/lib/hash.mjs:11`: `IMAGE_EXCLUDE` skips `docs/`, `e2e/`, tests and `*.spec.ts`, but not
  `README.md` or other `*.md`. `.dockerignore` keeps them out of the images, but the hash counts them → "image inputs
  changed" → rebuild → `check-e2e-fresh` FAIL → full E2E.
- Cause 2, `workflows/build-slice.js` green loop: every round runs related verify → full verify → focus E2E → full E2E →
  full review, unconditionally. After a green focus run the full run repeats the same 72 specs (issue 11).
- Cause 3: a README finding names a root file → `layerOfFile` returns null → both builders start.
- Cause 4: every open medium finding blocks the close, whether it is a product defect or a test-hardening wish
  (issue 12: 6 medium in round 2, 2 of them hardening) → one full round per review.
- Cause 5: the FR-43 README check lives in Playwright (`e2e/tests/readme.spec.ts`), although it needs no browser.
- Measured suite costs: full backend ~8–9.5 min (~6 min of it real-time waits in a few ITs; 111 Spring contexts),
  full E2E ~20 min (169 tests, `workers: 1`), frontend ~10 s.
- Slice 03 as a whole (retro-slice-03.md): 5 h 54 min, ~124 agent runs, ~4.4 M subagent tokens. E2E 111 min (4 full
  runs ~20 min each + 3 focus runs ~7.6 min). Time classes: real work ~54 % · factory false stops/bugs ~21 % (YAML at
  the spec gate, check-sync required→optional, the fixed `verify --related` bug) · gate design ~20 % (the README round,
  focus+full double runs, full verify every round) · app test cost ~4 %.
- Round 4 should have been a takeover (one-line fix, syntax check, close). "Take control after round 3" is now the
  user's rule.

## Design rules
1. **Fail-safe inputs.** Every file belongs to an explicit, documented group (backend, frontend, e2e, docs). Any other
   file — root files, compose, `.oracul/`, `api/`, Dockerfiles, unknown files — is **shared**: an input of every gate.
   Only the documented exclude list may skip a file.
2. **The slice gate is unchanged in strength.** Close = full backend + full frontend + every E2E spec + review, each
   green on the current input hash. What changes: a gate already green on the current hash isn't run again.
3. No new subSteps, no renamed state fields; the ledger is a new file next to `state.json`. Doc formats change only
   additively (`kind` in review findings), with parser, template and fixtures updated together.
4. Every item has red and green self-test cases; `node self-test/run.mjs` → N/N after each.

## Work packages

### G1 — input groups and the gate ledger
- `checks/lib/inputs.mjs`: `groupOf(rel)` → `backend` (backend/**, minus build output), `frontend` (frontend/**, minus
  build output and the generated client), `e2e` (e2e/**, minus reports), `docs` (`docs/**`, `**/*.md`) or `shared`
  (everything else, including unknown files). `gateHash(appDir, gate)`:
  - `backend`: backend + shared + every doc file a backend test names (see G8)
  - `frontend`: frontend + shared + every doc file a frontend spec names
  - `e2e:<spec>`: image inputs (G2) + e2e non-test files (config, helpers) + that spec file
  - `docs`: docs + the doc checks (G7)
- `state/apps/<app>/gates.json`: `{ "<gate>": { hash, result, full, at } }`, written by the gate commands only:
  a full verify writes `backend`/`frontend` (full: true); an official E2E run writes one entry per spec from the
  Playwright JSON report (pass/fail). Related or focus runs never write `full: true`.
- `bin/gates.mjs status [--json]` lists each gate as `green (current)`, `green (stale)`, `red` or `never`.
- Self-test: README change → only the `docs` gate is stale (green); backend file → `backend` stale and every
  `e2e:*` stale (image changed), frontend green (green); `api/openapi.yaml` or an unknown root file → every gate stale
  (red for any skip); a related run never marks a gate full (red/green pair).

### G2 — image hash from `.dockerignore`, docs never in it
- `imageInputsHash` excludes what the app's `.dockerignore` excludes (simple glob patterns: `**/x`, `dir/`, `*.ext`,
  `!` negation), plus the documented list (`docs/`, `e2e/`, tests, `*.spec.ts`, `**/*.md`). Without a `.dockerignore`:
  the documented list only. The template `.dockerignore` and `migrate.mjs --speed` add `**/*.md`.
- Self-test: README change → image hash unchanged (green); `.dockerignore` excludes `notes/` → `notes/x` ignored
  (green); a negated pattern (`!keep.md`) is honoured (green); a file not excluded anywhere changes the hash (red).

### G3 — incremental verify
- `verify --incremental --slice <s>`: per layer, if `gates.json` has it green on the current hash → `SKIP <layer>:
  green on the current inputs (<at>)`; otherwise run the layer **full** and record it. All checks still run;
  coverage is read from the last full run of each layer (the skipped layer's reports are unchanged by definition).
- `verify --reuse-if-fresh` (slice close) and the release's first verify use the ledger: fresh when every layer gate is
  green on the current hash.
- Self-test: README-only change → both layers skipped, checks run, GREEN (green); frontend change → frontend runs,
  backend skipped (green); shared change → both run (red for a skip); a skipped layer's coverage still counts (green).

### G4 — E2E: run only specs that aren't green on the current inputs (complement, not a repeat)
- `stack.mjs e2e --detach --needed`: the spec list = every spec whose `e2e:<spec>` gate is not green on the current
  hash. An empty list → `E2E NOTHING NEEDED` (exit 0, nothing started). Runs as an **official** run: per-spec results
  (status, duration, the hash it ran on, its QA screenshots) go into the ledger `gates.json`.
- Playwright's own `report/results.json` is **not rewritten** (no hand-made Playwright format). The readers move to the
  ledger: `check-e2e-fresh`, check-artifacts `playwrightGreen` and `gen-traceability` use the per-spec ledger entries when
  the ledger exists, and the report otherwise (older apps, first run). A spec counts only on its current hash.
- `check-e2e-fresh`: fresh = every spec gate green on its current hash, and the spec set equals the specs on disk (a new
  or deleted spec counts).
- **Project `dependencies`** (session-2 item 10): Playwright always runs a selected project's dependency projects, so a
  scoped run drags them along. `--needed` keeps them (they are setup — auth, seed data); F6 warns when a dependency
  project contains real tests, and `testing-rules` says dependency projects are setup only. Never `--no-deps` blindly
  (it would skip required setup).
- Fix rounds: no separate focus run any more — the needed set *is* the focus. With an unchanged image (tests/docs-only
  rounds) only changed or failed specs run; with a changed image every spec is needed once, at the slice gate (G5).
- Self-test: only `e2e/tests/a.spec.ts` changed → needed = [a] (green); image changed → all specs needed (green);
  nothing changed → NOTHING NEEDED, no lock taken (green); a new spec file → needed (red for "fresh"); ledger keeps the
  green entries of untouched specs and replaces re-run ones (green); a spec green on an old hash is not fresh (red);
  gen-traceability and playwrightGreen read the ledger, and fall back to the report without one (green/green);
  screenshots of reused specs stay valid evidence (green).

### G5 — the green loop: targeted rounds, one slice gate at the end
- A fix round runs, in order, only what its changes need:
  1. **pre-checks** (G7) for docs/shell changes — seconds;
  2. **related tests** of the changed layers only (`verify --related`, layers without changes skipped);
  3. **needed E2E specs** related to the slice and to the failures (image unchanged: only those; image changed:
     slice-related + failed specs);
  4. **delta review** (G6).
- When the round is clean (targeted checks green, no open blocking finding): the **slice gate** — `verify --incremental`
  (full run of every stale layer) + `stack.mjs e2e --needed` (every spec not green on the current hash). Green → close.
  Red → triage → next round.
- A README-only round therefore runs: doc pre-check + the tests that read the README (G8) + delta review, and its slice
  gate finds every layer and spec still green → close.
- Self-test (workflow stubs): README-only change → no builder of a code layer, no verify of a layer, no Docker build, no
  E2E, a delta review, close (green); one frontend file → frontend related + needed specs + delta review, then the gate
  (green); slice gate red → triage and another round (red); the close is refused while `gates.mjs` shows a stale gate
  (red).

### G6 — delta review after round 1, findings split into defect and hardening
- After each review, `bin/snapshot.mjs` records the working tree as a git tree id (`GIT_INDEX_FILE` temp index +
  `write-tree`; no commit, no index change) in `state/apps/<app>/review-snapshot.json`. From round 2 the reviewer gets:
  "re-check the open findings against `git diff <tree>` and review that diff" — no full-slice re-review.
- `review-findings.json` gets `kind: "defect" | "hardening"` per finding (additive; a missing kind counts as defect).
  `check-review` blocks on open findings with severity **high** (any kind) or **medium defects**. Open **medium
  hardening** findings don't block the close: they're listed in `rounds.md`, passed to the tester in the same round if
  a round happens anyway, and handed to the release review as input.
- Reviewer rule: `hardening` only for a request to strengthen a test of behaviour that an existing passing test already
  covers; anything a user could hit is a defect.
- Open hardening findings collect in `state/apps/<app>/hardening.json`; the release review gets them as input, and the
  final report lists what is still open as "Hardening backlog" (never silently dropped).
- Self-test: open medium hardening → close allowed, listed (green); open medium defect → blocked (red); open high
  hardening → blocked (red); missing kind → treated as defect (red); snapshot doesn't change the index or HEAD (green).

### G7 — cheap pre-checks for docs and shell
- `checks/check-docs.mjs`: for changed `*.md`, extract ```` ```bash|sh|zsh|shell ```` blocks and run `bash -n` (and
  `zsh -n` when zsh exists) on each; for changed `*.sh`, the same. Reports the block's file and line. Runs first in a
  round that touches such files, and in the slice gate.
- Self-test: `((cd x))` style arithmetic-vs-subshell bug caught by `zsh -n`/`bash -n` where it is a syntax error, an
  unclosed quote caught (red); valid blocks pass (green); no shell blocks → PASS (green).
- Note: `-n` checks syntax only; `((cd …))` is valid arithmetic syntax in bash, so the README *test* (G8) stays the
  behavioural check — the pre-check catches the cheap class of mistakes in seconds.

### G8 — doc checks belong in plain tests, and docs map to the tests that read them
- Analyst (Step 4a) and `testing-rules`: checks of README commands or file presence go into a backend JUnit test (plain
  JUnit, no Spring context, reads `../README.md`) — never into Playwright.
- `related.mjs`: a changed doc file relates to every test file that names it (e.g. `README.md`); those tests are its
  "related tests", and the doc becomes an input of that test's layer gate (G1).
- Self-test: README change → related = the test that reads it, nothing else (green); a doc no test names → no test
  (green); the backend gate hash includes README only when a backend test names it (green/red pair).

### G9 — takeover after round 3 (the user's rule), code kept
- `maxRounds` default 3. Not clean after round 3 → `STOPPED "takeover: <leftover>"`: code kept, not parked; the
  leftover (failing gates, open blocking findings, the files involved) in `rounds.md` and in the result.
- **Takeover procedure** (`skills/factory/SKILL.md`, an explicit exception to rule 4 "the orchestrator writes no app
  code"): the orchestrator may fix the listed leftover itself — small, targeted fixes only. It sets the matching subStep
  first (`green` for code, `test-fix` for tests — the guard's role limits stay), logs why with `state.mjs note` (D2),
  runs the cheap checks (pre-checks G7, related tests), then an **independent** delta review (`oracul:reviewer` agent,
  never itself) and finally `bin/close-slice.mjs` (G11). If the leftover is not small (several files, a design question),
  it asks the user instead.
- Self-test: 3 red rounds → STOPPED "takeover" with the leftover, nothing parked (red for BLOCKED); a clean round 2 →
  DONE (green); `maxRounds` override still works (green).

### G11 — `bin/close-slice.mjs`: one deterministic close for the workflow and the takeover
- The close chain moves out of the workflow into a command: slice gate (G3 incremental verify + G4 needed E2E, or
  `--check-only` when they already ran), `check-review --slice`, `check-e2e-fresh`, artifacts `--stage done`,
  coverage ratchet `--update`, commit, slice DONE, subStep none, retro (D1) — in that order, stopping at the first
  failure with the reason. The workflow's close calls it; so does the takeover. No other way to mark a slice DONE.
- Self-test: the existing close-order case now asserts the command's internal order (green); a stale gate → refused,
  nothing committed (red); an open blocking finding → refused (red); after a takeover fix: green gates + clean review →
  DONE and committed (green).

### D1 — slice retro, generated (no agent)
- `bin/retro.mjs --slice <s>` writes `docs/<phase>/04_build/<slice>/retro.md` at DONE, STOPPED and BLOCKED (called by
  close-slice and by the workflow's STOPPED/BLOCKED returns) from data that exists: `timings.jsonl` (time per subStep),
  a new `gate-runs.jsonl` (every gate run: gate, exit, duration, input hash, attempt — appended by verify, red-check,
  stack e2e, compile-check), `rounds.md`, `suite-health.json`, `gates.json`, interventions (D2).
- Contents: timeline with %, gate runs with **same-hash reruns flagged as waste**, rounds (what failed, routed to whom,
  did the same failure return), slowest tests and their diff, scope size (FRs, superseded tests, contract diff lines),
  delay classes (D2). Ends with the five-line summary the orchestrator shows the user:
  `03_x DONE in 2h41m · 2 rounds · Time: build 48% · verify 22% · E2E 18% · stops 12% · Waste: 31m (…) · Slowest: …`.
- Agent counts/tokens are not visible to engine scripts; the orchestrator may append them from the workflow result
  (`--agents "<n> runs, <tokens>"`).
- The retro is additive (a new doc, not in the manifest's required set).
- Self-test: from fixture timings + gate runs → timeline sums to the wall time, a same-hash double run is flagged
  (green); missing data → the section says "no data", never fails the close (green); retro never changes exit codes of
  close (red case for the opposite).

### D2 — interventions log and delay classes
- `state.mjs note "<why>" [--tag scope|app-tests|factory-false-positive|agent-error|infra|external-service]` appends to
  `state/apps/<app>/notes.jsonl` (timestamp, slice, subStep). Required in the takeover (G9) and for any manual
  `state.mjs set subStep` outside a workflow (SKILL rule).
- Every STOPPED result is tagged automatically where the cause is known: stack busy / guard / timeout / worker lost →
  `infra`; factory command error → `factory-false-positive`; sync/park failures → `factory-false-positive` unless the
  output names the app. Tagged factory entries also go to `state/apps/<app>/factory-issues.jsonl` (gate, output excerpt,
  repro command) — the factory-issue backlog that replaces hand-written lists.
- Self-test: note appended with tag (green); unknown tag refused (red); a STOPPED "factory command error" lands in
  factory-issues.jsonl (green); notes and issues appear in the retro (green).

### G10 — honest labels
- The `e2e-wait` runner calls are labelled `waiting for E2E (n/8)`, so "still running" no longer looks like a failure in
  `/workflows`. Self-test: label check on the workflow stubs.

## Acceptance (measured with `state.mjs timings` on the next slices)
| Round type | Today | Target |
|---|---|---|
| README-only fix | ~45 min | **< 5 min** (doc pre-check + README test + delta review; gate finds everything green) |
| One frontend file | ~45 min | **~10–15 min** for the round (frontend tests + needed specs + delta review) |
| Slice gate (once) | every round | stale layers in full + needed E2E specs only |
| Close | — | refused while any gate is stale (ledger) |
| After round 3 | rounds 4–5, ~30–45 min each | takeover: targeted fix + delta review + close-slice |
| Slice end | hand-written retro | generated retro + five-line summary; factory issues in a backlog file |

The target for a one-frontend-file round counts the round itself. When the image changed, every E2E spec is needed
once at the slice gate; that costs a full E2E run (~20 min today, ~5–6 min after the app's parallel-workers work).

## Risks
| # | Risk | Likelihood / impact | Mitigation | Left over |
|---|---|---|---|---|
| R1 | A gate is skipped although its inputs changed (missed input) → a red slips through | Low / High | Unknown files are shared inputs of every gate; only the documented exclude list skips; red self-test cases per group; the slice gate re-checks hashes at close | None found |
| R2 | E2E per-spec reuse hides a cross-spec effect (spec B broken by a change that only re-ran spec A) | Low–Med / High | Any image change makes every spec needed once at the slice gate; per-spec reuse only on an unchanged image | Spec order effects inside an unchanged image (already the case today) |
| R3 | Merged Playwright report misreads results (stale entries shown as green) | Low / High | Each entry carries the hash it ran on; `check-e2e-fresh` and `gen-traceability` accept an entry only on the current hash | None |
| R4 | `.dockerignore` parsing differs from Docker's (exotic patterns) | Low / Med | Supported subset documented; an unsupported pattern → ignored for exclusion (file counts → rebuild), never the other way | Extra rebuilds |
| R5 | The reviewer labels a defect as hardening to get a close | Low–Med / Med | High always blocks; hardening defined narrowly; missing kind = defect; hardening goes to the release review | Judgement remains with the reviewer |
| R6 | Delta review misses an issue outside the diff | Med / Low–Med | Open findings are re-checked; the release review is a full review | Slightly less re-review |
| R7 | Escalating after round 3 stops slices that round 4 would have fixed | Med / Low | Code kept, "continue" gives more rounds; `maxRounds` overridable | One user decision |
| R8 | Ledger out of sync (a file edited outside the workflow) | Med / Low | Hashes are recomputed at every gate from disk; the ledger only says "green on hash X" | None |
| R9 | Larger workflow change (green loop restructured) breaks existing guarantees | Med / High | All current workflow self-test cases stay; replay through the guard; smoke covers a README-only round and a one-file round for real | None found |
| R10 | Takeover weakens role separation (the orchestrator writes code) | Med / Med | Only after round 3 and only for a listed small leftover; guard subStep limits stay; logged (D2); an independent reviewer agent; close only via close-slice with every gate | The orchestrator's judgement on "small" |
| R11 | Moving the close chain into a command changes close behaviour | Low / High | Same order and checks as today, asserted by self-test; the workflow calls the command | None |
| R12 | The ledger becomes the source for E2E evidence; a bug there misreports QA | Low / High | Report fallback without a ledger; per-spec hash check; smoke compares ledger vs a full run once | None |

## Relation to round 3 (F1–F7)
- **F1 (skip a broad focus run)** is superseded by G4/G5 (no separate focus run; the needed set is the focus).
- **F5 (release reuses the verify)** is superseded by G3 (the ledger makes reuse exact).
- **F2, F3, F4, F6, F7, F10** stay (F6/F7 revised, F10 added); they don't conflict.
- Order for one factory session: **G2** (quick win: no rebuild/E2E for docs) → F2, F3, F4 (the false stops: ~21 % of
  slice 03) → F10 → D2 (notes/tags, needed by G9) → G1, G8, G7, G3, G4 → G6 → G11 → G5 → G9 → G10 → F6, F7 → D1.

## App-side follow-ups (not factory work — the app session's maintenance prompt)
- Replace real-time waits in the news-search ITs with an injected `Clock`/fake time (backend ~8 → ~2 min per full run).
- Move the README checks out of `e2e/tests/readme.spec.ts` into a plain test, keep the real-shell run, drop the walker.
- Parallel E2E workers with isolated test data (E2E ~20 → ~5–6 min); Gradle test-retry block (the migration was
  refused because `build.gradle.kts` is customised).

## Run prompt (factory session, between slices)
```
Implement plans/2026-10-04-factory-round-3.md items F2, F3, F4, F6, F7, F10 and
plans/2026-10-04-factory-round-4-incremental-gates.md items G1–G11, D1, D2 (F1 and F5 are superseded) with automerge.
App paused: yes
1. Read AGENTS.md and both plans. Worktree: git worktree add ../factory-engine-r4 -b round-4 main. Work only there;
   never touch ../apps/ or state/.
2. Order: G2, F2, F3, F4, F10, D2, G1, G8, G7, G3, G4, G6, G11, G5, G9, G10, F6, F7, D1 — one commit each ("R<n>: <what>"), each with its
   red + green self-test cases; node self-test/run.mjs must print N/N before each commit. Never weaken a check.
3. Smoke: add steps for a README-only round (no rebuild, no E2E, gate finds everything green), a one-file frontend
   round (only needed specs, ledger vs report agree), contract validation on the real generators, and a close via
   bin/close-slice.mjs that writes retro.md. Run node bin/env-check.mjs, then
   node self-test/smoke.mjs. Bump the plugin version.
4. Automerge only if: self-test N/N, smoke green, "App paused: yes", app at subStep none, no state/apps/*/stack.lock.
   If main moved, rebase and re-test. git merge --ff-only round-4 in the main checkout, self-test there; on failure
   reset to the pre-merge commit and report. Remove the worktree, keep the branch.
5. Report: commits, self-test count, smoke result, merged yes/no, round times expected; then: restart the app session,
   "continue", and compare `state.mjs timings` of the next slice with slice 03.
```
