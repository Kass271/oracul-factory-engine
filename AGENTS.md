# Oracul factory-engine — rules for developing the factory

This folder is the **factory**, packaged as a local Claude Code plugin (`oracul`). It builds apps into `../apps/`.
These rules apply when you *change the factory*. Building apps is a different session — see "Two kinds of session".

## Two kinds of session
| | Building an app | Developing the factory (this file) |
|---|---|---|
| Start | `cd oracul && claude --plugin-dir ./factory-engine` | `cd oracul/factory-engine && claude` |
| Trigger | "Start new phase development: <idea>" | normal work on this folder |
| Hooks | active (engine read-only, phase guards) | not loaded |
| Touches `../apps/` | yes | **never** |

## Map
```
.claude-plugin/plugin.json   plugin manifest
skills/       factory (orchestrator) · clarify · stack-rules · testing-rules · qa-rules · status · run
agents/       analyst · tester · backend-builder · frontend-builder · reviewer · qa-documenter
workflows/    build-slice.js (Step 4, stage red | green — red-check runs between them as a direct orchestrator command)
              finish-and-run.js (Step 5) — called by scriptPath, no fs access inside
hooks/        hooks.json + session-start · guard-edits (Playwright/Docker only via stack.mjs; official E2E only in subStep e2e)
              post-edit · subagent-stop · stop
checks/       verify (--related = development loop) + check-traceability · check-coverage · check-contract · check-review
              check-artifacts · check-e2e-fresh (every E2E spec green on the current inputs) · check-sync (contract
              sync adds no behaviour; --release: no marker left) · check-stack (stack modes) · check-docs (shell syntax
              of changed docs) · gen-traceability
              manifest/artifacts.manifest.json
              lib/ (core, docs parsers, red analysis + FLAKY, lock = stack lock, e2e = scratch/focus env + failure block,
              related = related tests of a slice + FALLOUT/LEAK, timing = subStep timings + slowest tests, hash = image/E2E
              inputs, compile = compile-only runs + labels, openapi = contract readers, stack = stack modes,
              inputs = input groups + gate ledger (gates.json), coverage = report readers)
bin/          state.mjs (only state writer; timings, flaky) · env-check · scaffold · red-check (--scope slice) · commit
              compile-check (compile only, labelled diagnostics; contract sync + older-test listing)
              migrate (existing apps → current scaffold, at slice boundaries; sets speed, contract)
              gates (ledger status) · close-slice (the one way to DONE) · snapshot (delta review) · retro (slice retro)
              stack (Docker + E2E; up/down/e2e hold the stack lock; up skips the build when image inputs are unchanged;
              e2e --detach + e2e-wait = official run beyond the 10-min runner limit; e2e --scratch = tester's scoped run;
              e2e --focus-slice = a fix round's related specs)
templates/    app/ (skeleton overlay) · docs/ (one template per step document)
self-test/    run.mjs + fixtures/app-green (red cases are mutations of the green fixture)
state/        runtime state of generated apps (gitignored)
```

## Model policy
| Who | Model | Effort |
|---|---|---|
| analyst, reviewer | opus | high |
| triage (decides code vs test) | opus | high |
| tester | sonnet | high |
| backend-builder, frontend-builder (also in sync) | sonnet | medium |
| qa-documenter, failure note | sonnet | medium |
| command runner (one shell command per call) | haiku | low |
Set in `agents/*.md` (model, effort) and in the workflows' `ROLE_MODEL` / agent options — every agent call names its
model, so nothing depends on the session's model. The integrity self-test enforces it.

## Speed principle — green stays green
Related tests while developing (red-check --scope slice, verify --related, builder loops, related E2E specs); the slice
gate once when the round is clean (verify --incremental + every E2E spec not green on the current inputs). The gate
ledger (`state/apps/<app>/gates.json`, checks/lib/inputs.mjs) records each gate on the hash of its inputs; a gate green
on unchanged inputs is never re-run. Every file belongs to a group; unknown files are shared (input of every gate).
A development-loop shortcut never counts as the slice gate; `bin/close-slice.mjs` is the only way to DONE.

## Hard rules
1. **Never weaken a check.** If a check is wrong, fix it so it is *right*, and prove it with a red and a green case.
2. **Every change to a check, hook, state command or the manifest comes with self-test cases** in `self-test/run.mjs`:
   one case that must fail (red) and one that must pass (green).
3. **`node self-test/run.mjs` must print `N/N self-test cases passed` before a change is done.**
4. Engine scripts use Node built-ins only (no npm dependencies) and must run on the Node version the apps require.
5. Never edit `state/` by hand — use `bin/state.mjs`. Never touch `../apps/` from a factory session.
6. Doc formats are contracts: `checks/lib/docs.mjs` parses `templates/docs/*`. Change both together, plus fixtures.
7. Workflow scripts: `export const meta` first, plain JS, no `Date.now()`/`Math.random()`/`new Date()`, return `{ error }` on missing args.

## How to add a check
1. Write `checks/check-<name>.mjs` using `lib/core.mjs` (`Report`: PASS / MISSING / INVALID, exit 0/1).
2. If it guards an artifact, add a manifest entry (`checks/manifest/artifacts.manifest.json`) with a rule in `check-artifacts.mjs`.
3. Register it in `checks/verify.mjs`.
4. Add red + green cases to `self-test/run.mjs`; run the self-test.
5. Mention it in `skills/factory/SKILL.md` if the orchestrator calls it directly.

## How to add an agent or skill
- Agent: `agents/<name>.md` with frontmatter `name`, `description`, `tools`, `model`; state what it may write and what it never does.
  Add its write limits to `hooks/guard-edits.mjs` (via a subStep) and its finish check to `hooks/subagent-stop.mjs`.
- Skill: `skills/<name>/SKILL.md` with frontmatter `name` (= folder name) and a `description` that says when to use it.
- The integrity self-test checks frontmatter of both.

## Smoke test of the whole factory
`node self-test/run.mjs` covers checks, state and hooks offline. The full smoke (real scaffold, Gradle, Angular, Docker,
Playwright) is `node self-test/smoke.mjs` — it needs the environment from `bin/env-check.mjs`.
