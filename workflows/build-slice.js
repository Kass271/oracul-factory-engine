export const meta = {
  name: 'oracul-build-slice',
  description: 'Oracul Step 4, one slice in two stages: stage "red" = spec delta → RED tests (the orchestrator then runs red-check itself); stage "green" = builders → verify → E2E → independent review, test problems to the tester, max 5 fix rounds, then DONE (commit) or BLOCKED (failure note)',
  phases: [
    { title: 'Spec', detail: 'analyst sharpens spec + contract for the slice' },
    { title: 'Sync', detail: 'contract sync: production code compiles again after a contract change — marker stubs and declared renames only' },
    { title: 'Red', detail: 'tester writes failing tests and self-checks them with red-check (the gate run is outside, as a direct command)' },
    { title: 'Green', detail: 'builders (code) and tester (tests) fix, verify, E2E, independent review — up to 5 rounds' },
    { title: 'Close', detail: 'ratchet + artifacts + commit, or failure note + impact' },
  ],
}

// args: { engine, root, app, appDir, phase, phaseDir, slice, frs: [..], stage: 'red'|'green', agentNs?: 'oracul', maxRounds?: 3 }
//   stage red:   redFeedback?  — red-check output of the rejected previous attempt (skips the spec step)
//                resumeAfterSpec? — skip the spec step (its docs are done), e.g. after the user accepted a large slice
//                acceptSize?   — the user decided to keep a slice the size check flagged (F7)
//   stage green: red: { exitCode, output } — result of `node bin/red-check.mjs --slice <s>` run by the orchestrator
const A = args || {}
const need = ['engine', 'root', 'app', 'appDir', 'phase', 'phaseDir', 'slice', 'stage']
const missing = need.filter((k) => !A[k])
if (missing.length) return { error: `build-slice: missing args ${missing.join(', ')} — args did not reach the script` }
if (!['red', 'green'].includes(A.stage)) return { error: `build-slice: stage must be "red" or "green", got ${A.stage}` }
if (A.stage === 'green' && (!A.red || typeof A.red.exitCode !== 'number')) return { error: 'build-slice: stage green needs red: { exitCode, output } from red-check' }

const NS = A.agentNs || 'oracul'
const MAX = A.maxRounds || 3 // after round 3: takeover by the orchestrator (the user's rule), never rounds 4–5
const S = A.slice
const FRS = (A.frs || []).join(', ')
const node = (script, rest) => `node "${A.engine}/${script}" ${rest || ''}`.trim()
const sliceDir = `${A.phaseDir}/04_build/${S}`
const CTX = `App: ${A.appDir}\nPhase docs: ${A.phaseDir}\nSlice: ${S} (FRs: ${FRS})\nSpecs: ${A.phaseDir}/02_specs/\nContract: ${A.appDir}/api/openapi.yaml\nEngine (read-only): ${A.engine}`

const RUN_SCHEMA = {
  type: 'object',
  properties: { exitCode: { type: 'integer' }, output: { type: 'string' } },
  required: ['exitCode', 'output'],
}
const PROBLEMS = { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, problem: { type: 'string' } }, required: ['file', 'problem'] } }
const BUILDER_SCHEMA = {
  type: 'object',
  properties: { summary: { type: 'string' }, testProblems: PROBLEMS },
  required: ['summary', 'testProblems'],
}
const TRIAGE_SCHEMA = {
  type: 'object',
  properties: { code: { type: 'string' }, layers: { type: 'array', items: { type: 'string', enum: ['backend', 'frontend'] } }, tests: PROBLEMS },
  required: ['code', 'tests'],
}
// Which builders a code fix needs: round 1 and "unknown" → both; otherwise only the failing layer(s).
const LAYERS = ['backend', 'frontend']
const builderLayers = (w, round) => {
  const l = (w.layers || []).filter((x) => LAYERS.includes(x))
  return round === 1 || !l.length ? LAYERS : [...new Set(l)]
}
// Owners (F10): compose files and stub services → backend builder, frontend/nginx.conf → frontend builder; repository docs
// (README.md, *.md outside a layer, docs/ other than the factory's own) → backend builder alone — a docs fix never
// starts both builders.
const layerOfFile = (f) => (/^backend\//.test(f || '') || /^(docker-)?compose(\.[\w-]+)?\.ya?ml$/.test(f || '') || /^[^/]+\.md$/i.test(f || '') ? 'backend' : /^frontend\//.test(f || '') ? 'frontend' : null)
const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    open: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, severity: { type: 'string' }, kind: { type: 'string' }, dimension: { type: 'string' }, file: { type: 'string' }, problem: { type: 'string' }, fix: { type: 'string' } },
        required: ['id', 'severity', 'dimension', 'file', 'problem'],
      },
    },
  },
  required: ['open'],
}

// Deterministic command runner: executes exactly one command, changes nothing else.
// Gate calls (their exit code decides something) get `echo "ORACUL_EXIT=$?"` appended on its own line, and their exit
// code is read ONLY from that line — a runner once reported a failure for a command that succeeded. No sentinel → one
// rerun (every gate command is safe to repeat) → still none → 125 'runner returned no exit code'. A guard refusal or a
// runner timeout (124) has no sentinel by nature and is never rerun. Kill switch: workflow arg exitSource: 'runner'.
const SENTINEL_LINE = /\n?ORACUL_EXIT=\d+[^\n]*/g
const readSentinel = (out) => { const all = [...String(out || '').matchAll(/ORACUL_EXIT=(\d+)/g)]; return all.length ? Number(all.at(-1)[1]) : null }
const isGuardBlock = (r) => r.exitCode !== 0 && /\[oracul guard\]|PreToolUse:Bash hook error/.test(r.output || '')
async function sh(cmd, label, opts = {}) {
  const gate = !!opts.gate && A.exitSource !== 'runner'
  const full = gate ? `${cmd}\necho "ORACUL_EXIT=$?"` : cmd
  let r = await runOnce(full, label)
  if (!gate) return r
  let code = readSentinel(r.output)
  if (code === null && r.exitCode !== 124 && !isGuardBlock({ exitCode: r.exitCode || 1, output: r.output })) {
    log(`${label}: runner returned no exit sentinel — rerunning once`)
    r = await runOnce(full, `${label} (no exit code, retry)`)
    code = readSentinel(r.output)
  }
  const output = String(r.output || '').replace(SENTINEL_LINE, '')
  if (code !== null) return { exitCode: code, output }
  if (r.exitCode === 124) return { exitCode: 124, output }
  if (/\[oracul guard\]|PreToolUse:Bash hook error/.test(output)) return { exitCode: r.exitCode || 1, output }
  return { exitCode: 125, output }
}
// A broken command line (a factory bug, not the app's code) — the builders cannot fix it.
const HARNESS_ERROR = /Problem configuring task \S+ from command line|Unknown command-line option '[^']+'|Task '[^']+' not found in (root )?project|Could not find or load main class org\.gradle\.wrapper|Unknown option: --/
// Infrastructure failures are never code failures: no triage, no fix round. null = a real result.
function infraReason(r) {
  const out = r.output || ''
  if (r.exitCode !== 0 && HARNESS_ERROR.test(out)) return `factory command error (${(out.match(HARNESS_ERROR) || [''])[0].slice(0, 80)})`
  if (r.exitCode === 3 || /STACK BUSY/.test(out)) return 'stack busy'
  if (isGuardBlock(r)) return 'blocked by guard hook'
  if (r.exitCode === 125) return 'runner returned no exit code'
  if (r.exitCode === 124) return 'timed out'
  if (r.exitCode === 4 || /E2E WORKER LOST/.test(out)) return 'e2e worker lost'
  return null
}
// The command is fenced with more backticks than any run inside it: note() bodies contain ``` blocks, and a plain
// ``` fence ended the command early for the runner model.
// Every STOPPED is logged with a delay class (state.mjs note --tag); factory causes also go to the factory-issue backlog.
const shArg = (t) => `"${String(t).replace(/["\\$`]/g, '\\$&').replace(/\s+/g, ' ').slice(0, 400)}"`
function delayTag(failing) {
  const f = failing.join(' ')
  if (/factory command error/.test(f)) return 'factory-false-positive'
  if (/stack busy|blocked by guard hook|timed out|e2e worker lost|runner returned no exit code|^park:|\bpark:/.test(f)) return 'infra'
  if (/sync: contract invalid/.test(f)) return 'agent-error'
  if (/^start:|^close:/.test(f)) return 'agent-error'
  if (/^takeover:|^size:/.test(f)) return 'scope'
  return 'scope'
}
async function logStop(result) {
  const tag = delayTag(result.failing || [])
  await sh(`${node('bin/state.mjs', `note ${shArg(`STOPPED ${S}: ${(result.failing || []).join('; ')} — ${String(result.output || '').split('\n').filter(Boolean).slice(-2).join(' / ')}`)} --tag ${tag}${tag === 'factory-false-positive' ? ' --issue' : ''}`)}; ${node('bin/retro.mjs', `--slice ${S}`)}`, `log stop ${S}`)
  return result
}
const fenceFor = (cmd) => '`'.repeat(Math.max(3, ...[...String(cmd).matchAll(/`+/g)].map((m) => m[0].length + 1)))
async function runOnce(cmd, label) {
  const f = fenceFor(cmd)
  const res = await agent(
    `Run exactly this shell command from the directory ${A.root} and report the result. Use the Bash tool in the foreground with timeout 600000 (never run_in_background). Do not modify files yourself, do not retry, do not try to fix anything. If the command times out, report exitCode 124. The command is everything between the two ${f} fence lines — run all of it, unchanged, as ONE Bash call.\n\n${f}bash\n${cmd}\n${f}\n\nReturn exitCode (the command's real exit status) and output (the last 80 lines of combined stdout/stderr, verbatim).`,
    { label: `run: ${label}`, schema: RUN_SCHEMA, model: 'haiku', effort: 'low' },
  )
  return res || { exitCode: 1, output: 'runner returned nothing' }
}

// Model policy (AGENTS.md): every agent call names its model and effort — nothing depends on the session's model.
const ROLE_MODEL = { analyst: ['opus', 'high'], reviewer: ['opus', 'high'], tester: ['sonnet', 'high'], 'backend-builder': ['sonnet', 'medium'], 'frontend-builder': ['sonnet', 'medium'], 'qa-documenter': ['sonnet', 'medium'] }
const modelOf = (name) => { const [model, effort] = ROLE_MODEL[name] || ['sonnet', 'medium']; return { model, effort } }
// Role agents: plugin agent type first; fall back to a generic agent that loads the role file.
async function role(name, prompt, label, schema) {
  const opts = { ...(schema ? { label, schema } : { label }), ...modelOf(name) }
  try {
    const r = await agent(prompt, { ...opts, agentType: `${NS}:${name}` })
    if (r !== null) return r
  } catch (e) {
    log(`agent type ${NS}:${name} unavailable (${e}) — using role file`)
  }
  return agent(`You are the Oracul ${name}. First read ${A.engine}/agents/${name}.md and follow it exactly (also load the skills it names).\n\n${prompt}`, opts)
}

// Append a section to rounds.md — idempotent: a runner that executes the command twice (it happened) appends it once.
// Only an exact repeat of the file's last block is skipped, so a resumed run can still write its own "Round 1".
const note = (title, body) => {
  const f = `${sliceDir}/rounds.md`
  return sh(`mkdir -p "${sliceDir}" && n=$(mktemp) && cat > "$n" <<'ORACUL_EOF' && { tail -c "$(($(wc -c < "$n")))" "${f}" 2>/dev/null | cmp -s - "$n" || cat "$n" >> "${f}"; }; rm -f "$n"\n\n## ${title}\n${body}\nORACUL_EOF`, `note ${title}`)
}
// Official E2E, three kinds of call so none comes near the runner's 10-minute limit (the suite alone took 9.5 min):
//   1. `set subStep e2e && stack.mjs up` (docker build; subStep e2e is the only one the hook lets run the stack)
//   2. `stack.mjs e2e --detach` — Playwright starts in a background worker that holds the stack lock
//   3. `stack.mjs e2e-wait --max 480`, repeated while it answers 75 (still running), up to E2E_WAITS times
// "stack busy" on 1 or 2 is rerun once; anything else infrastructure-like ends up in infraReason().
const E2E_WAITS = 8
// E2E of the specs that are not green on the current inputs (gate ledger) — official runs, each spec recorded.
//   focus = a round: only those among the slice's related specs, the failed ones and the changed spec files
//   otherwise = the slice gate: every spec not green on the current inputs
// A probe (dry run, in subStep e2e) answers "E2E NOTHING NEEDED" → no stack up, no Playwright.
async function e2eNeeded(label, focus) {
  const retryBusy = async (cmd, l) => {
    let r = await sh(cmd, l, { gate: true })
    if (infraReason(r) === 'stack busy') { log(`${l}: stack busy — rerunning once`); r = await sh(cmd, `${l} (stack busy, retry)`, { gate: true }) }
    return r
  }
  const sel = `--needed${focus ? ` --focus ${S}` : ''}`
  const probe = await retryBusy(`${node('bin/state.mjs', 'set subStep e2e')} && ${node('bin/stack.mjs', `e2e ${sel} --dry-run`)}`, `${label}: which specs?`)
  if (probe.exitCode !== 0) return probe
  if (/E2E NOTHING NEEDED/.test(probe.output)) return { exitCode: 0, output: probe.output, nothing: true }
  const up = await retryBusy(node('bin/stack.mjs', 'up --mode e2e'), `${label}: docker up`)
  if (up.exitCode !== 0) return up
  const start = await retryBusy(node('bin/stack.mjs', `e2e --detach ${sel}`), `${label}: start Playwright`)
  if (start.exitCode !== 0 || /E2E NOTHING NEEDED/.test(start.output)) return { ...start, nothing: /E2E NOTHING NEEDED/.test(start.output) }
  for (let i = 1; i <= E2E_WAITS; i++) {
    const w = await sh(node('bin/stack.mjs', 'e2e-wait --max 480'), `${label}: waiting for E2E (${i}/${E2E_WAITS})`, { gate: true })
    if (w.exitCode !== 75) return w
  }
  return { exitCode: 124, output: `E2E still running after ${E2E_WAITS} waits of 480 s` }
}
const failureBlock = (out) => (String(out || '').match(/==== E2E FAILURES[\s\S]*?==== END E2E FAILURES ====/) || [''])[0]
const NO_E2E = 'Do not run Playwright, docker compose or stack.mjs up/down/e2e — the workflow\'s E2E step runs them (hook-enforced). Unit/integration tests (./gradlew test, npm run test:ci) are fine. For E2E failures read the E2E FAILURES block you were given.'
const TESTER_E2E = `For an E2E test in the list, read the E2E FAILURES block and its trace first. You may verify your repair once or twice with ${node('bin/stack.mjs', 'e2e --scratch --grep <spec file>')} (Bash, foreground, timeout 600000; it waits for the lock and takes minutes). Never run Playwright directly. Scratch results are not evidence — the workflow's E2E step decides.`

const isTest = (f) => /(^|\/)(backend\/src\/test\/|e2e\/tests\/)|\.spec\.ts$/.test(f || '')
const list = (ps) => ps.map((p) => `- ${p.file}: ${p.problem}`).join('\n')

// Decide who fixes a failing gate: the tester (test is broken or contradicts the spec) or the builders (code).
async function triage(gate, output, hints, round) {
  const t = await agent(`${CTX}\n\nThe ${gate} gate of slice ${S} failed in round ${round}. Decide for every failure whether the CODE or the TEST is wrong. Read the specs, the failing tests and the code; change nothing.\n- TEST is wrong only when the test itself is broken (does not compile, flaky timing, shared data, selector/testid not in the spec) or asserts something the spec/contract does not say (including behaviour a later spec changed).\n- Otherwise the CODE is wrong — a test that matches the spec is never the problem.\n- verify labels older failing tests: FALLOUT = fails on its own (a production/contract change broke it: TEST if this slice's spec changes that behaviour, else CODE); LEAK = passes on its own (other tests leak state: TEST). FLAKY lines are informational — never a reason for a fix.\n\nBuilders flagged these tests as suspicious (hints, not verdicts):\n${hints.length ? list(hints) : '(none)'}\n\nFailure output:\n\`\`\`\n${output.slice(-6000)}\n\`\`\`\n\nReturn code = the failures the builders must fix, as precise instructions with the relevant output lines ("" if none), layers = which builders that code fix needs ("backend", "frontend" or both; leave empty if unsure — stack wiring: compose files and stub services are "backend", frontend/nginx.conf routes are "frontend"), and tests = the test files the tester must repair, each with the reason.`, { label: `triage: ${gate} ${S} r${round}`, schema: TRIAGE_SCHEMA, model: 'opus', effort: 'high' })
  if (!t || (!t.code && !t.tests.length)) return { code: `${gate} is RED:\n${output}`, tests: [] }
  return t
}

const SYNC_BRIEF = `Contract sync — make production code compile again after the contract change and add NO behaviour. Allowed, and nothing else:
1. A method the generated interfaces now require: keep its signature on ONE line; body \`throw new NotImplementedException();\` (com.oracul.app.common.NotImplementedException) — in TypeScript \`return notImplemented();\` (src/app/not-implemented.ts).
2. A missing switch branch: \`case X -> throw new NotImplementedException();\`; a missing map/record entry: \`[Key.X]: notImplemented(),\`.
3. Renames exactly as declared in ${A.phaseDir}/02_specs/contract-notes.md ("Renamed: Old → New"), and changed signatures of the same method.
4. Imports.
No logic, no new fields, no deletions, no tests, no contract — ${node('checks/check-sync.mjs')} checks every added and removed line, and the slice's builders implement the behaviour later in the green stage. ${NO_E2E}`
const countOf = (re, out) => { const m = String(out || '').match(re); return m ? Number(m[1]) : null }
// → null when production code compiles (or the contract did not change), else the STOPPED result of stage red.
async function contractSync() {
  const stop = (why, output) => note('Contract sync stopped', `- ${why}\n- No tester ran; nothing parked. The user decides (a large or undeclared contract break).\n- Output:\n\n\`\`\`\n${String(output).slice(-2500)}\n\`\`\``)
    .then(() => logStop({ stage: 'red', status: 'STOPPED', slice: S, failing: [`sync: ${why}`], output: String(output).slice(-1500) }))
  // An invalid contract is the analyst's, not the builders': one repair, then STOPPED (slice 03: unquoted YAML).
  let valid = await sh(node('checks/check-contract.mjs', '--validate'), `validate contract ${S}`, { gate: true })
  if (infraReason(valid)) return stop(infraReason(valid), valid.output)
  if (valid.exitCode !== 0) {
    await sh(node('bin/state.mjs', 'set subStep spec'), 'state → spec (contract invalid)')
    await role('analyst', `${CTX}\n\nThe contract does not parse or validate — the generators reject api/openapi.yaml:\n${valid.output.slice(-2500)}\nRepair api/openapi.yaml (quote values that contain ": " or start with special characters; keep the meaning). Contract and docs only. Done when ${node('checks/check-contract.mjs', '--validate')} exits 0.`, `analyst: repair contract ${S}`)
    valid = await sh(node('checks/check-contract.mjs', '--validate'), `validate contract ${S} (after repair)`, { gate: true })
    if (valid.exitCode !== 0) return stop(`contract invalid after one analyst repair${infraReason(valid) ? ` (${infraReason(valid)})` : ''}`, valid.output)
  }
  let compile = await sh(node('bin/compile-check.mjs', '--stage main --if-contract-changed'), `compile main ${S}`, { gate: true })
  if (compile.exitCode === 0) return null
  if (infraReason(compile)) return stop(infraReason(compile), compile.output)
  await sh(node('bin/state.mjs', 'set subStep sync'), 'state → sync')
  let guard = { exitCode: 0, output: '' }
  let prev = Infinity
  for (let i = 1; i <= 4; i++) {
    const errors = (compile.exitCode ? countOf(/COMPILE ERRORS: (\d+)/, compile.output) ?? 1 : 0) + (guard.exitCode ? countOf(/SYNC VIOLATIONS: (\d+)/, guard.output) ?? 1 : 0)
    if (errors >= prev) return stop(`no progress after ${i - 1} sync round(s) — ${errors} problem(s) left`, `${guard.output}\n${compile.output}`)
    prev = errors
    const layers = ['backend', 'frontend'].filter((l) => new RegExp(`FAIL\\s+${l} main`).test(compile.output) || new RegExp(`${l}/src/`).test(guard.output))
    const problems = `${guard.exitCode ? `check-sync rejected these lines — undo or replace them with marker stubs:\n${guard.output.slice(-2500)}\n\n` : ''}${compile.exitCode ? `Compiler output:\n${compile.output.slice(-4000)}` : ''}`
    await parallel((layers.length ? layers : ['backend', 'frontend']).map((layer) => () => role(`${layer}-builder`, `${CTX}\n\n${SYNC_BRIEF}\n\nRound ${i} for ${S}, ${layer}:\n${problems}`, `${layer}: sync ${S} r${i}`, BUILDER_SCHEMA)))
    guard = await sh(node('checks/check-sync.mjs'), `check-sync ${S} r${i}`, { gate: true })
    compile = await sh(node('bin/compile-check.mjs', '--stage main'), `compile main ${S} r${i}`, { gate: true })
    if (infraReason(guard) || infraReason(compile)) return stop(infraReason(guard) || infraReason(compile), `${guard.output}\n${compile.output}`)
    if (guard.exitCode === 0 && compile.exitCode === 0) {
      await note('Contract sync', `- Production code compiles again after ${i} round(s); check-sync: marker stubs, declarations and declared renames only.\n\n\`\`\`\n${guard.output.slice(-1200)}\n\`\`\``)
      return null
    }
  }
  return stop('production code still does not compile after 4 sync rounds', `${guard.output}\n${compile.output}`)
}

// ================================================================ stage red
if (A.stage === 'red') {
  phase('Spec')
  if (!A.redFeedback && !A.resumeAfterSpec) {
    await sh(`${node('bin/state.mjs', `set slice ${S}`)} && ${node('bin/state.mjs', `slice ${S} IN_PROGRESS`)} && ${node('bin/state.mjs', 'set subStep spec')}`, 'state → spec')
    await role('analyst', `${CTX}\n\nStep 4a — slice spec delta for ${S}. Make the spec(s) covering ${FRS} and api/openapi.yaml precise enough to write failing tests without guessing (paths, payloads, statuses, ApiError.code values, UI route, data-testid names). Every FR of the slice must get the line "- Changes earlier behaviour: none | <old> → <new> (tests: <app-relative test files> | none)" — find those tests by grepping the existing tests for every path, field, error code, data-testid, ordering and outbound call this slice changes. If an FR changes how the Docker stack starts (compose files, profiles, stub vs real mode), write ${A.appDir}/.oracul/stack.json with mode "e2e" (the stack the factory's E2E tests — deterministic, stubs on) and mode "run" (what the user starts), see ${A.engine}/checks/lib/stack.mjs — and the line "- Ranges & invariants: none | <input ranges with valid/invalid classes, rules that must hold for all data>". Keep contract changes additive where you can; declare every renamed schema, property or enum value in ${A.phaseDir}/02_specs/contract-notes.md as "Renamed: Old → New" (one line each), and list every existing test a changed response breaks under "Changes earlier behaviour". Done when ${node('checks/check-artifacts.mjs', `--step 04_build --slice ${S} --stage spec`)} exits 0. Do not touch code or tests.`, `analyst: spec ${S}`)
  }
  // F7: a large rewrite of older tests is known only after the spec delta — the user decides before the tester starts.
  if (!A.redFeedback && !A.acceptSize) {
    const size = await sh(node('checks/check-artifacts.mjs', `--step 04_build --slice ${S} --stage spec`), `slice size ${S}`, { gate: true })
    const warn = (size.output.match(/SLICE SIZE: [^\n]*/) || [])[0]
    if (warn) {
      await note('Slice size', `- ${warn}\n- Stopped before the tester: the user decides — split the slice (plan change, analyst) or continue with acceptSize.`)
      return logStop({ stage: 'red', status: 'STOPPED', slice: S, failing: [`size: ${warn}`], output: warn })
    }
  }
  // Contract sync — on the first attempt and on every retry: a contract change can leave production code uncompilable,
  // and only builders may touch it. They make it compile with marker stubs and declared renames; check-sync proves no
  // behaviour was added. No progress → STOPPED (the user decides), never a doomed red retry.
  phase('Sync')
  const stopped = await contractSync()
  if (stopped) return stopped
  // Older tests that no longer compile after the contract change must be listed (the analyst), before the tester starts.
  const listed = await sh(node('bin/compile-check.mjs', `--stage tests --slice ${S} --require-listed --if-contract-changed`), `older tests compile? ${S}`, { gate: true })
  const unlisted = (listed.output.match(/^UNLISTED .*$/gm) || [])
  if (unlisted.length) {
    await sh(node('bin/state.mjs', 'set subStep spec'), 'state → spec (unlisted older tests)')
    await role('analyst', `${CTX}\n\nStep 4a addendum for ${S}: after the contract change these existing tests no longer compile and are not listed under "Changes earlier behaviour":\n${unlisted.join('\n')}\nAdd each to the "Changes earlier behaviour" line of the FR whose change breaks it ("<old> → <new> (tests: <file>)"). Docs only. Done when ${node('checks/check-artifacts.mjs', `--step 04_build --slice ${S} --stage spec`)} exits 0.`, `analyst: list older tests ${S}`)
  }
  phase('Red')
  await sh(node('bin/state.mjs', 'set subStep red'), 'state → red')
  const extra = A.redFeedback ? `\n\nThe previous attempt was rejected by red-check:\n${A.redFeedback}\nFix every NOT-RED / WRONG-REASON problem it lists so the tests compile and fail only because the behaviour is missing.` : ''
  await role('tester', `${CTX}\n\nStep 4b — write the RED tests for slice ${S} (FRs ${FRS}), including the Playwright E2E test for every FR with "UI: yes". Tag every test "// @trace FR-x". Every test file the spec lists under "Changes earlier behaviour (tests: …)" is outdated: update it to the new spec now, keep its @trace tags (also any other test that now contradicts the spec), and list them in your final message. Every FR with "Ranges & invariants" other than none gets a parameterized/exhaustive test over the whole range. Self-check before finishing: run ${node('bin/red-check.mjs', `--slice ${S} --scope slice`)} yourself (Bash, foreground, timeout 600000; it runs only the slice's related tests) — at most 3 runs. It must print RESULT: RED; read every failure message and fix every test that fails for a reason other than missing behaviour (type mismatch, unscripted stubs, state leaking between tests, stale counters, unfinished async work) — the builders cannot change tests. Stop and report instead of investigating further when what is left is outside your control: production code does not compile (\`Task :compileJava FAILED\`), a FLAKY older test, or a Spring context that fails because production code is missing. Never poll with sleep.${extra}`, `tester: red ${S}${A.redFeedback ? ' (retry)' : ''}`)
  return { stage: 'red', slice: S, next: `node "${A.engine}/bin/red-check.mjs" --slice ${S} --scope slice` }
}

// ================================================================ stage green
const red = A.red
let status = red.exitCode === 0 ? 'GREEN-PENDING' : 'BLOCKED'
let failing = red.exitCode === 0 ? [] : ['red-check']
let rounds = 0
let feedback = ''
if (status === 'BLOCKED') await note('Red phase failed', `red-check could not confirm valid RED tests:\n\n\`\`\`\n${(red.output || '').slice(-3000)}\n\`\`\``)

// ---------------------------------------------------------------- Green + E2E + review loop
phase('Green')
// work.code → builders · work.tests → tester (never the other way round)
let work = { code: 'Implement the slice until all its RED tests (unit, integration and E2E) pass.', tests: [] }
let e2eFailures = '' // E2E FAILURES block of the last official run, forwarded unchanged to the next fix round
// Infrastructure failure (stack busy, guard refusal, runner without exit code, timeout): the gate never judged the
// code, so the slice is neither triaged nor parked — it STOPS with its code kept, and "continue" resumes it.
let stopped = null
// The docs the close step checks (slice spec lines, red-evidence) are checked now, before any builder writes code:
// found here a doc problem costs nothing; found at close it would cost the whole build.
if (status === 'GREEN-PENDING') {
  const start = await sh(node('checks/check-artifacts.mjs', `--step 04_build --slice ${S} --stage red`), `start checks ${S}`, { gate: true })
  if (start.exitCode !== 0) {
    const why = infraReason(start) || (start.output.split('\n').map((l) => l.trim()).find((l) => /^(INVALID|MISSING)\b/.test(l)) || `exit ${start.exitCode}`)
    await note('Start check failed', `- ${why}\n- No builder ran; nothing to park. Fix the named doc (02_specs → analyst Step 4a; red-evidence → red-check), then resume stage green.\n- Output:\n\n\`\`\`\n${start.output.slice(-1500)}\n\`\`\``)
    return logStop({ status: 'STOPPED', slice: S, rounds: 0, failing: [`start: ${why}`], output: start.output.slice(-1500) })
  }
}
while (status === 'GREEN-PENDING' && rounds < MAX) {
  rounds++
  // State changes ride on the next command (fewer runner calls); every gate keeps its own sentinel.
  if (work.tests.length) {
    await sh(`${node('bin/state.mjs', 'round +1')} && ${node('bin/state.mjs', 'set subStep test-fix')}`, `round ${rounds} → test-fix`)
    await role('tester', `${CTX}\n\nFix round ${rounds} — repair these tests of slice ${S} (production code is locked for you):\n${list(work.tests)}\n\nThe spec and contract are the authority: make each test assert exactly what they say. Never weaken an assertion just to make it pass, never delete a test of an FR that is still valid, keep every @trace tag. Run the affected tests before finishing. ${TESTER_E2E}${e2eFailures ? `\n\n${e2eFailures}` : ''}`, `tester: fix ${S} r${rounds}`)
  }
  let hints = []
  if (work.code) {
    await sh(work.tests.length ? node('bin/state.mjs', 'set subStep green') : `${node('bin/state.mjs', 'round +1')} && ${node('bin/state.mjs', 'set subStep green')}`, `${work.tests.length ? '' : `round ${rounds} → `}state → green r${rounds}`)
    const task = rounds === 1 ? work.code : `Fix round ${rounds}. Fix exactly these problems:\n${work.code}`
    const tail = `\n\nWhile you work, run only the slice's tests (backend: ./gradlew test --tests <classes from ${sliceDir}/red-evidence.md and your fix list>; frontend: npm run test:ci -- --include <those specs>); run your whole layer once before you finish. Tests are locked for you. If you believe a test is wrong (contradicts the spec, broken, flaky), do not work around it — report it in testProblems; the tester fixes tests. ${NO_E2E}${e2eFailures ? `\n\n${e2eFailures}` : ''}`
    const rs = await parallel(builderLayers(work, rounds).map((layer) => () => role(`${layer}-builder`, `${CTX}\n\nStep 4c — ${layer} for ${S}. ${task}${tail}`, `${layer}: ${S} r${rounds}`, BUILDER_SCHEMA)))
    hints = rs.filter(Boolean).flatMap((r) => r.testProblems || [])
  }
  // After a tests-only round the state is still test-fix (and round +1 is pending): both ride on the first verify.
  const toGreen = work.code ? '' : `${work.tests.length ? '' : `${node('bin/state.mjs', 'round +1')} && `}${node('bin/state.mjs', 'set subStep green')} && `
  e2eFailures = ''
  // A failing gate of this round → triage → next round. Returns true when the round must end.
  const failed = async (gate, r, label) => {
    if (infraReason(r)) { stopped = { gate, reason: infraReason(r), output: r.output }; return true }
    if (r.exitCode === 0) return false
    failing = [gate]
    feedback = `${label} is RED:\n${r.output}`
    if (gate === 'e2e') { e2eFailures = failureBlock(r.output); await sh(node('bin/state.mjs', 'set subStep green'), `state → green r${rounds} (after ${label})`) }
    work = await triage(label, r.output, hints, rounds)
    await note(`Round ${rounds}`, `- Trigger: ${label} RED\n- To builders: ${work.code ? 'yes' : 'no'} · to tester: ${work.tests.map((t) => t.file).join(', ') || 'no'}\n- Output:\n\n\`\`\`\n${String(r.output).slice(-3000)}\n\`\`\``)
    return true
  }

  // 1. cheap pre-check (seconds): shell syntax of changed docs and scripts
  if (await failed('docs', await sh(`${toGreen}${node('checks/check-docs.mjs')}`, `docs syntax r${rounds}`, { gate: true }), 'docs syntax check')) { if (stopped) break; continue }
  // 2. the related tests of what changed (layers without related tests are skipped)
  if (await failed('verify', await sh(node('checks/verify.mjs', `--related --slice ${S}`), `verify related r${rounds}`, { gate: true }), 'verify (related tests)')) { if (stopped) break; continue }
  // 3. the slice's related E2E specs that are not green on the current inputs
  if (await failed('e2e', await e2eNeeded(`e2e r${rounds}`, true), 'E2E (related specs not green on the current inputs)')) { if (stopped) break; continue }

  // From round 2 the reviewer reviews the delta since its last review (snapshot tree), not the whole slice again.
  const snap = rounds > 1 ? await sh(`${node('bin/state.mjs', 'set subStep review')} && ${node('bin/snapshot.mjs', '--show')}`, `state → review r${rounds}`) : await sh(node('bin/state.mjs', 'set subStep review'), `state → review r${rounds}`)
  const tree = ((snap.output || '').match(/TREE ([0-9a-f]{40})/) || [])[1]
  const delta = tree ? ` Delta review: re-check every open finding in the file against the current code, then review only the output of \`${node('bin/snapshot.mjs', '--diff')}\` (the changes since your last review, tree ${tree}, new files included) — not the whole slice again.` : ''
  const flagged = hints.length ? `\n\nThe builders flagged these tests as possibly wrong — judge them under dimension "tests":\n${list(hints)}` : ''
  const rv = await role('reviewer', `${CTX}\n\nStep 4e — review slice ${S}, round ${rounds}. The uncommitted changes are the slice work: git -C "${A.appDir}" status / diff HEAD. The round's related tests and E2E specs are GREEN (the slice gate runs after a clean review). Write ${sliceDir}/review-findings.json with "round": ${rounds}; give every finding a "kind" (defect | hardening, see your rules).${delta} If ${sliceDir}/red-evidence.md has a section "Red by startup only", check those tests under dimension "tests": each must assert real behaviour, not just that the context starts. Return the findings that are still open with severity high or medium (the same ones as in the file).${flagged}`, `reviewer: ${S} r${rounds}`, REVIEW_SCHEMA)
  const c = await sh(`${node('bin/snapshot.mjs')} >/dev/null; ${node('checks/check-review.mjs', `--slice ${S}`)}`, `check-review r${rounds}`, { gate: true })
  if (infraReason(c)) { stopped = { gate: 'review', reason: infraReason(c), output: c.output }; break }
  if (c.exitCode === 0) {
    // 4. the slice gate, once the round is clean: every stale layer in full + every E2E spec not green on the current
    // inputs. Green → close. Red → triage → next round (targeted again).
    if (await failed('verify', await sh(`${node('bin/state.mjs', 'set subStep green')} && ${node('checks/verify.mjs', '--incremental')}`, `slice gate: verify r${rounds}`, { gate: true }), 'slice gate: verify (stale layers in full)')) { if (stopped) break; continue }
    if (await failed('e2e', await e2eNeeded(`slice gate r${rounds}`, false), 'slice gate: E2E (every spec not green on the current inputs)')) { if (stopped) break; continue }
    status = 'DONE'; failing = []; break
  }
  failing = ['review']
  feedback = `Review findings (open high/medium in ${sliceDir}/review-findings.json):\n${c.output}`
  const open = (rv && rv.open) || []
  const testFindings = open.filter((f) => f.dimension === 'tests' || isTest(f.file))
  const codeFindings = open.filter((f) => !testFindings.includes(f))
  const findingLayers = codeFindings.map((f) => layerOfFile(f.file))
  work = open.length
    ? {
        code: codeFindings.length ? `Review findings (${sliceDir}/review-findings.json):\n${codeFindings.map((f) => `- ${f.id} [${f.severity}] ${f.file}: ${f.problem}${f.fix ? ` — fix: ${f.fix}` : ''}`).join('\n')}` : '',
        layers: findingLayers.includes(null) ? [] : findingLayers,
        tests: testFindings.map((f) => ({ file: f.file, problem: `${f.id} [${f.severity}] ${f.problem}${f.fix ? ` — fix: ${f.fix}` : ''}` })),
      }
    : { code: `${feedback}\nRead the open findings in the file; findings about tests are for the tester — report them in testProblems.`, tests: [] }
  await note(`Round ${rounds}`, `- Trigger: review not clean\n- To builders: ${codeFindings.map((f) => f.id).join(', ') || (open.length ? 'none' : 'all (findings not returned)')} · to tester: ${testFindings.map((f) => f.id).join(', ') || 'none'}\n- ${c.output.split('\n').filter((l) => /INVALID|MISSING/.test(l)).join('\n- ')}`)
}
if (stopped) {
  await note(`Round ${rounds}`, `- Trigger: ${stopped.gate} could not run — ${stopped.reason} (infrastructure, not a code failure). Not triaged, slice STOPPED, code kept in the working tree; "continue" resumes at stage green.\n- Output:\n\n\`\`\`\n${stopped.output.slice(-1500)}\n\`\`\``)
  await sh(node('bin/state.mjs', 'set subStep green'), 'state → green (stopped)')
  return logStop({ status: 'STOPPED', slice: S, rounds, failing: [`${stopped.gate}: ${stopped.reason}`], output: stopped.output.slice(-1500) })
}
// Not clean after the last round → STOPPED for the takeover: the code is kept (never parked), the leftover is listed.
if (status === 'GREEN-PENDING') {
  const leftover = `${failing.join(', ') || 'unknown'} after ${rounds} round(s)`
  await note('Takeover', `- Not clean after ${rounds} round(s): ${failing.join(', ')}.\n- Code kept, not parked. The orchestrator takes over (small targeted fix, independent delta review, bin/close-slice.mjs) or asks the user.\n- Last output:\n\n\`\`\`\n${String(feedback || '').slice(-2500)}\n\`\`\``)
  return logStop({ status: 'STOPPED', slice: S, rounds, failing: [`takeover: ${leftover}`], output: String(feedback || '').slice(-1500), leftover: { failing, work } })
}

// ---------------------------------------------------------------- Close
phase('Close')
// Close: re-verify only if something changed since the round's full verify (a partial test run by the reviewer
// rewrites the coverage report and JUnit XML), then the checks, then the mutations — baseline, commit, and DONE last.
// A failing close never parks: verify, E2E and review already passed, so the code stays and the slice STOPS.
if (status === 'DONE') {
  // One deterministic close (bin/close-slice.mjs) — the same command the orchestrator's takeover uses.
  const close = await sh(node('bin/close-slice.mjs', `--slice ${S} --check-only`), `close ${S}`, { gate: true })
  if (close.exitCode === 0) return { status, slice: S, rounds, failing: [], output: close.output.slice(-1500) }
  const why = infraReason(close) || (close.output.split('\n').map((l) => l.trim()).find((l) => /^(INVALID|MISSING)\b|^==== VERIFY RED/.test(l)) || (close.output.match(/CLOSE FAILED at "[^"]+"/) || [])[0] || `exit ${close.exitCode}`)
  await note('Close failed', `- ${why}\n- Not parked: verify, E2E and review had passed. The slice stays IN_PROGRESS with its code; "continue" resumes it at stage green.\n- Output:\n\n\`\`\`\n${close.output.slice(-1500)}\n\`\`\``)
  await sh(node('bin/state.mjs', 'set subStep green'), 'state → green (close failed)')
  return logStop({ status: 'STOPPED', slice: S, rounds, failing: [`close: ${why}`], output: close.output.slice(-1500) })
}

// BLOCKED: write the failure note, park the code, keep the docs, decide CONTINUE/STOP.
await agent(`Write ${sliceDir}/failure-note.md for the Oracul slice ${S} (FRs ${FRS}) using the template ${A.engine}/templates/docs/failure-note.md.\nFacts (use only these and the files ${sliceDir}/rounds.md, ${sliceDir}/red-evidence.md, ${sliceDir}/review-findings.json if present):\n- rounds used: ${rounds} of ${MAX}\n- failing: ${failing.join(', ')}\n- last output:\n${(feedback || red.output || '').slice(-3000)}\nKeep the heading "## What failed". Write only that one file.`, { label: `failure note ${S}`, model: 'sonnet', effort: 'medium' })
// The impact is read first (read-only), then the park runs as one checked gate. The slice is marked BLOCKED only after
// the code was parked and the docs committed — if the park cannot run (refused, timed out, no exit code), nothing is
// marked: the slice STOPS with its code kept and the user decides.
const imp = await sh(node('bin/state.mjs', `impact ${S}`), `impact ${S}`, { gate: true })
const m = imp.output.match(/\{"slice".*\}/)
const impact = m ? JSON.parse(m[0]) : { decision: 'STOP', dependents: ['unknown — impact not readable'] }
const park = await sh([
  `git -C "${A.appDir}" checkout HEAD -- backend frontend e2e api`,
  `git -C "${A.appDir}" clean -fdq -- backend/src frontend/src e2e/tests`,
  node('bin/commit.mjs', `--message "${A.phase} ${S}: BLOCKED after ${rounds} round(s) — docs only (${FRS})"`),
  node('bin/state.mjs', `slice ${S} BLOCKED`),
  node('bin/state.mjs', 'set subStep none'),
].join(' && '), `park ${S}`, { gate: true })
if (park.exitCode !== 0) {
  const why = infraReason(park) || `exit ${park.exitCode}`
  await note('Park failed', `- The slice failed after ${rounds} round(s) (${failing.join(', ')}), but parking it failed: ${why}.\n- Not marked BLOCKED; the code is in the working tree as far as the park got. The user decides (continue the slice, or park it).\n- Output:\n\n\`\`\`\n${park.output.slice(-1500)}\n\`\`\``)
  return logStop({ status: 'STOPPED', slice: S, rounds, failing: [...failing, `park: ${why}`], output: park.output.slice(-1500) })
}
await sh(node('bin/retro.mjs', `--slice ${S}`), `retro ${S}`)
return { status: 'BLOCKED', slice: S, rounds, failing, decision: impact.decision, dependents: impact.dependents }
