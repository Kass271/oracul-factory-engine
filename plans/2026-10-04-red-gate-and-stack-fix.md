# Oracul factory fix plan — red gate, red-check diagnostics, startup failures, stack modes, model setup

Status: **IMPLEMENTED** on branch `red-gate-fix` (commits P, F, G, K, H, I, M, Q — 2026-10-04), stacked on the speed-up.
Decisions: all recommended (D1=A, D2, D3, D5, D6 yes; D7 Haiku runner). Builders run on medium effort (speed priority).
Overlap with the speed-up: WP-K's isolation rerun runs in the full verify (red-check is scoped, D9); FLAKY stays its
own class; migrate.mjs has sets `speed` and `contract`; the stack guard covers `.oracul/stack.json` only (compose files
stay app config builders may edit; a new extra compose file without modes makes stack.mjs refuse).

## How to run this plan
1. Pause app development at a clean point (section 0 below).
2. Start a factory session: `cd oracul/factory-engine && claude`
3. Say: **"Implement plans/2026-10-04-red-gate-and-stack-fix.md. Decisions: D1=A, D2=…, D3=yes, D5=yes, D6=yes"**
   (or "all recommended"). Before starting, check `git log` for work packages that already landed.
4. One commit per work package, in the order P → F → G → K → H → I → M → Q → J.
   `node self-test/run.mjs` must print `N/N self-test cases passed` after each (AGENTS.md hard rules 1–7 apply).
5. Afterwards, resume the app as described in "Resume after the work".

## Problems covered

| # | Problem | Fixed by |
|---|---|---|
| 1 | A contract change breaks the production compile before red-check | WP-P (prevent), WP-G (repair) |
| 2 | red-check hides compiler output (only "compile error"; `tail 50` of Gradle has no javac lines; console strips fenced output) | WP-F |
| 3 | Older tests fail from contract fallout (`"providerCode": null`) and are labelled "state leak / no production code changed" | WP-P, WP-K |
| 4 | A Spring startup failure caused by missing production validation (/callback URI) is labelled "test configuration bug" | WP-H |
| 5 | stack.mjs always runs plain `docker compose`; with FR-42 (stub opt-in via docker-compose.e2e.yml) factory E2E would hit real mode, `down` would leave the stub running. Blocks slice 03 | WP-I |
| 6 | The documented red retry reruns only the tester, who can't fix production-side causes → red retry → green with nonzero exit → BLOCKED for a factory reason | WP-G |
| — | Model setup: triage and role fallback inherit the session's model; no effort levels set | WP-Q |

Root causes found in the code:
- `templates/app/backend/build.gradle.kts`: `interfaceOnly=true` + `skipDefaultInterface=true` → every new operation is an abstract method; Step 2 adds the whole phase's operations at once.
- No Jackson null-inclusion convention anywhere → every new optional field changes existing JSON.
- `hooks/guard-edits.mjs`: subStep red blocks prod; no builder runs before red-check.
- `checks/lib/red.mjs`: `COMPILE` regex → "compile error" only; `TEST_BUGS` lumps every `Failed to load ApplicationContext` as test bug; `junitFailures` keeps 15 stack lines (root cause cut off); older-test message assumes "no production code changed".
- `bin/red-check.mjs`: evidence keeps `tail(out, 50)`; console filter drops fenced output.
- `bin/stack.mjs`: `compose()` runs `docker compose` in appDir with no files/profiles; URLs hard-coded.

## How risk is kept low without slowing slices
1. **Prevent breakage instead of repairing it.** Template defaults stop most breakage before it happens.
2. **Checks are scripts, not agent judgement.** Seconds each, red and green self-test cases.
3. **New work runs only when triggered.** A slice whose contract didn't change pays ~1 s.
4. **When unsure, block.** An unclear case never passes the gate.

## Pace per slice

| Situation | Extra time | Compared with today |
|---|---|---|
| Contract unchanged since the last finished slice | ~1 s | same |
| Contract changed, code compiles | +20–40 s | same |
| Contract change breaks the compile | compile + one sync agent + diff check | faster: today this stops the phase |
| red-check hits a compile error | — | faster: skips the test run |
| Older tests fail | only those tests rerun | faster: no misdirected retry (15–25 min each) |
| High effort for tester, builders, triage | slower per call | fewer fix rounds; expected net faster |

## 0. Pause gate (before any factory work)
1. `state.mjs show --json` shows subStep `none`: the current slice is DONE or not started.
2. `stack.mjs down` has run with the current stack.mjs, and there is no `state/apps/<app>/stack.lock`.
3. The app's git tree is clean (committed).
4. Slice 03 stays blocked until WP-I lands.

## 1. Decisions

| # | Decision | Recommendation | Status |
|---|---|---|---|
| D1 | Stack modes: change the factory (A, a stack config the app declares) or work around it in the app (C, plain compose stays stub mode) | **A** | open |
| D2 | Which mode workflows use and which the `run` skill uses | Workflows `e2e`; `run` skill `run` | open |
| D3 | A startup failure counts as RED when caused by production code, linked to the slice spec, and only tagged classes fail | **Yes** | open |
| D5 | Null convention (`NON_NULL`) plus "no required + nullable" rule, for new apps | **Yes** | open |
| D6 | One-time migration of the paused app at resume (generator default methods + marker files only) | **Yes** | open |
| D7 | Command runner model | Haiku, low effort | **decided** |
| — | Per-test "must fail" check | Dropped: contract-generated validation makes some new tests pass legitimately at red | **decided** |

## 2. Work packages

### WP-P: prevent compile breakage in new apps (problems 1, 3)
- Backend template generator options:
  - `skipDefaultInterface=false`: a new operation becomes a default method returning 501 — red for the right reason, not a compile error.
  - `generatedConstructorWithRequiredArgs=false`: a new required field doesn't change constructors existing code calls.
- Template: `spring.jackson.default-property-inclusion: non_null` — null optional fields are left out of the JSON.
- `check-contract`: reject properties that are both `required` and `nullable: true`.
- `stack-rules`: map generated enums to domain enums at the boundary; no exhaustive `switch` over generated enums.
- Smoke proof on the real stack: a new operation compiles and returns 501; a null optional field is absent from the JSON; a new required field doesn't break existing callers.
- If an option misbehaves, smoke goes red before release; that option is dropped and sync covers the case.
- Self-test: options present (green) / missing (red); `required` + `nullable` rejected (red); plain optional passes (green).

### WP-F: red-check compiles first and shows compiler output as-is (problem 2)
- New `bin/compile-check.mjs`:
  - Stage 1 `./gradlew -q compileJava`, stage 2 `compileTestJava`; frontend `tsc --noEmit --pretty false`.
  - Quiet mode prints only diagnostics → shown verbatim, no parser to get wrong; capped at 60 lines.
  - Each line labelled `main`, `generated`, `test-new`, `test-old` from its path; unrecognised → `unknown`, text still shown.
- red-check runs compile-check first; on a compile error → WRONG-REASON with the diagnostics, test run skipped.
- `red-evidence.md` gets a new, additive diagnostics section (old evidence files still pass).
- Self-test seam `ORACUL_COMPILE_CMD`. red: main error, test-old error, unknown format — each labelled correctly. green: clean compile → exit 0; old-format `red-evidence.md` still passes check-artifacts.

### WP-G: contract sync in stage red (problems 1, 6)
1. **Trigger:** `git diff <base> -- api/openapi.yaml`, `<base>` = last `"<phase> <slice>: done"` or `00_setup` commit (`git log --grep`). No change → skip everything.
2. **Main code doesn't compile** → subStep `sync` + builder; guard allows production code only. Brief:
   - every stub uses the template marker: `throw new NotImplementedException()` (mapped to 501) / `notImplemented()` in TypeScript;
   - renames only as declared in `contract-notes` with `Renamed: Old → New`.
3. **`checks/check-sync.mjs`** — every added/changed line in the sync diff must be: import, annotation, brace, signature or comment; a line containing the marker; or a line equal to a removed line except for a declared rename. Anything else is rejected and the builder gets the offending lines.
4. **Rounds** continue while the error count drops. No progress → `STOPPED sync: <diagnostics>`; nothing parked.
5. **Older test files that don't compile** must be listed under "Changes earlier behaviour"; otherwise the analyst's spec step reruns with the list, before the tester.
6. **Retries:** sync runs on every red attempt (first and every retry) — fixes problem 6.
7. **Supporting changes:**
   - subStep `sync` added to `SUBSTEPS` (additive).
   - Guard: in sync, tests, contract, stack and stack config are blocked; `sync` in `LOCKED_OUT`.
   - `subagent-stop`: a builder in sync finishes only when compile-check and check-sync are green.
   - `rounds.md` records the sync diff stat.
   - Release check: no marker left for a DONE FR.
   - `skills/factory/SKILL.md`: resume rule `sync` → stage red; handling of `STOPPED sync:`.
   - Builder agents get a "Contract sync mode" section.
8. **Self-test:** guard in sync — prod allowed (green), test/contract/stack blocked (red); check-sync — marker stub passes (green), added logic rejected (red), declared rename passes (green), undeclared rename rejected (red); unchanged contract → skip (green); marker left at release → rejected (red).

### WP-K: correct cause for older-test failures (problem 3)
- When older tests fail, red-check reruns only those tests on their own:
  - **still fail alone** → `FALLOUT` (contract or production change caused it);
  - **pass alone** → `LEAK` (new tests leak state).
- Routing by line prefix: `FALLOUT` not listed under "Changes earlier behaviour" → retry stage red with the spec step; `LEAK` or test-bug signature → retry tester only; `main`/`generated` compile errors → retry stage red (sync again).
- Analyst rule: a contract change that alters existing responses must be listed under "Changes earlier behaviour".
- Self-test: red — fails alone → FALLOUT, passes alone → LEAK; green — listed and updated older test → no problem; routing red/green per prefix.

### WP-H: startup failures (problem 4; D3)
- Read the deepest `Caused by:` from the full stack trace (today only 15 lines are kept).
- RED only if all hold: throwing class / missing bean under `src/main` or generated code; the rejected property or type name appears in the slice's spec text (text search, doc format unchanged); only slice-tagged or listed classes fail. Otherwise WRONG-REASON.
- Evidence lists these classes as "red by startup only"; the list goes to the reviewer.
- Self-test: red — cause in test config; cause not in spec; older class also fails. green — production cause, spec-linked, tagged classes only.

### WP-I: stack config the app declares (problem 5; D1 = A)
- `.oracul/stack.json`: `project`, `files`, `profiles` per mode (`e2e`, `run`), `urls`. One pure `composeArgs()` builds every compose call (up, down, ps, logs, up inside e2e).
- Workflows pass `--mode e2e`; the `run` skill uses `--mode run` (D2).
- Post-conditions: after `down`, no container labelled with the project remains (else removed and reported); after `up`, running services match the mode.
- Block when unsure: extra `docker-compose.*.yml` files but no config → `up`/`e2e` refuse with exit 1.
- New guard kind `stack`: only the analyst writes the config and compose files, in subStep `spec`.
- No config and no extra files → today's command, byte-for-byte golden test.
- `check-artifacts` validates the config if present; `env-check` requires a minimum Compose version.
- Analyst declares both modes when an FR changes how the stack starts (FR-42, slice 03).
- Self-test (dry-run plans): up/down same set (green); extra file without config refused (red); golden no-config (green); leftover container after down cleaned and reported (red/green); guard — config write in green blocked (red), in spec allowed (green).
- If D1 = C instead: WP-I shrinks to a `stack-rules` rule "plain `docker compose up` stays the stub/E2E stack" plus the refuse-extra-files guard.

### WP-M: migrate the paused app (D6)
- `bin/migrate.mjs`, idempotent, run once from the app session at resume: sets `skipDefaultInterface=false` (adds default methods only) and adds the marker files.
- Then `verify` GREEN, then commit.
- Does not change null handling or constructors in the existing app.
- Self-test: first run applies, second changes nothing (green); modified build file refused, not overwritten (red).

### WP-Q: model setup

| Who | Model | Effort |
|---|---|---|
| analyst, reviewer | Opus 5.5 | high |
| triage (now set explicitly) | Opus 5.5 | high |
| tester, backend-builder, frontend-builder | Sonnet 5.5 | high |
| qa-documenter | Sonnet 5.5 | medium |
| command runner | Haiku | low |
| role-file fallback | same as the role it stands in for | explicit |

- `model` and `effort` in `agents/*.md`; if frontmatter doesn't support `effort`, set it in the workflows' `role()` calls.
- `triage()` and the role-file fallback get a fixed model.
- `AGENTS.md` gets the policy table.
- Self-test: red — agent without model/effort, model outside the allowed set, workflow `agent()` without model; green — this setup.

### WP-J: verify and hand back
1. `node self-test/run.mjs` → N/N passed.
2. `node self-test/smoke.mjs` → green, with WP-P proofs plus a "contract break → sync → red → green" run.
3. Bump the version in `plugin.json`.

## Resume after the work
1. "continue" in the app session (subStep `none`).
2. `migrate.mjs` → `verify` GREEN → commit.
3. Slice 03's spec delta writes the stack config for FR-42.
4. The analyst notes in slice 01's `rounds.md` that its skeletons and the `providerCode` change were made outside the workflow.

## 3. Risks

| # | Risk | Before | How it's removed | Left over |
|---|---|---|---|---|
| R1 | Sync slips in behaviour | Med / High | check-sync: every line is a marker stub, structure only, or a declared rename | None found |
| R2 | Sync can't make the code compile | Low–Med / Med | WP-P prevents most breaks; rounds while errors drop; STOPPED with diagnostics | A large undeclared break needs the user (rare) |
| R3 | Sync patches older tests | Med / High | Guard blocks tests; non-compiling old test files listed before the tester runs | None |
| R4 | `NON_NULL` hides a required null | Low / Med | check-contract forbids `required` + `nullable` | None |
| R5 | Existing apps keep the old null behaviour | Med / Med | FALLOUT names the cause and routes it to the analyst | Possible extra spec retry in old apps |
| R6 | Diagnostic parser misses formats | Med / Low | Quiet compile output verbatim; labels optional | None |
| R7 | A test bug accepted as startup-RED | Low / High | Production cause + spec link + tagged classes only; unclear → WRONG-REASON | A wrong value the spec mentions (very low; green triage catches it) |
| R8 | Startup failure hides each test's reason | High / Low–Med | Classes listed for the reviewer, who already runs | Low |
| R9 | Noisy "production changed" detection | Low / Low | Isolation rerun replaces git attribution | None |
| R10 | Stack config edited to ease E2E | Low / High | Only the analyst, only in `spec` (guard) | None |
| R11 | `down` leaves containers | Med / Med | Post-condition by project label, with cleanup | None |
| R12 | Existing apps or formats break | Low / High | Additive changes; golden and legacy self-test cases | None |
| R13 | Resume mid-stage under new rules | Med / Med | Pause gate; subSteps only added, never renamed/removed | None |
| R14 | compile-check slows slices | High / Low | Runs only when contract changed; red-check skips tests on compile error | Net faster |
| R15 | Slice 03 runs E2E against the real stack | Med / High | stack.mjs refuses extra compose files without config; slice 03 waits for WP-I | None |
| R16 | Workflow changes break determinism/time limits | Low / Med | Logic in engine scripts (seconds each); integrity self-test; smoke | None |
| R17 | A generator option behaves unexpectedly | Low / Med | Smoke proves each option before release; fallback is sync | Option dropped if smoke is red |
| R18 | check-sync rejects a valid stub | Low / Low | Builder gets offending lines, redoes next round | One extra round |
| R19 | High effort makes agent calls slower | High / Low | High only where it prevents rounds; runner Haiku low, qa-documenter medium | Slightly slower calls, fewer rounds |
| R20 | Agent frontmatter doesn't support `effort` | Med / Low | Effort set in workflows' `role()` calls | None |

Needs user input to stay low: R2 (large undeclared contract break), R7 (wrong value the spec happens to mention).
