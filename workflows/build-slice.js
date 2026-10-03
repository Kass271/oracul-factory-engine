export const meta = {
  name: 'oracul-build-slice',
  description: 'Oracul Step 4, one slice in two stages: stage "red" = spec delta → RED tests (the orchestrator then runs red-check itself); stage "green" = builders → verify → E2E → independent review, test problems to the tester, max 5 fix rounds, then DONE (commit) or BLOCKED (failure note)',
  phases: [
    { title: 'Spec', detail: 'analyst sharpens spec + contract for the slice' },
    { title: 'Red', detail: 'tester writes failing tests and self-checks them with red-check (the gate run is outside, as a direct command)' },
    { title: 'Green', detail: 'builders (code) and tester (tests) fix, verify, E2E, independent review — up to 5 rounds' },
    { title: 'Close', detail: 'ratchet + artifacts + commit, or failure note + impact' },
  ],
}

// args: { engine, root, app, appDir, phase, phaseDir, slice, frs: [..], stage: 'red'|'green', agentNs?: 'oracul', maxRounds?: 5 }
//   stage red:   redFeedback?  — red-check output of the rejected previous attempt (skips the spec step)
//   stage green: red: { exitCode, output } — result of `node bin/red-check.mjs --slice <s>` run by the orchestrator
const A = args || {}
const need = ['engine', 'root', 'app', 'appDir', 'phase', 'phaseDir', 'slice', 'stage']
const missing = need.filter((k) => !A[k])
if (missing.length) return { error: `build-slice: missing args ${missing.join(', ')} — args did not reach the script` }
if (!['red', 'green'].includes(A.stage)) return { error: `build-slice: stage must be "red" or "green", got ${A.stage}` }
if (A.stage === 'green' && (!A.red || typeof A.red.exitCode !== 'number')) return { error: 'build-slice: stage green needs red: { exitCode, output } from red-check' }

const NS = A.agentNs || 'oracul'
const MAX = A.maxRounds || 5
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
  properties: { code: { type: 'string' }, tests: PROBLEMS },
  required: ['code', 'tests'],
}
const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    open: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, severity: { type: 'string' }, dimension: { type: 'string' }, file: { type: 'string' }, problem: { type: 'string' }, fix: { type: 'string' } },
        required: ['id', 'severity', 'dimension', 'file', 'problem'],
      },
    },
  },
  required: ['open'],
}

// Deterministic command runner: executes exactly one command, changes nothing else.
async function sh(cmd, label) {
  const res = await agent(
    `Run exactly this shell command from the directory ${A.root} and report the result. Use the Bash tool in the foreground with timeout 600000 (never run_in_background). Do not modify files yourself, do not retry, do not try to fix anything. If the command times out, report exitCode 124.\n\n\`\`\`bash\n${cmd}\n\`\`\`\n\nReturn exitCode (the command's real exit status) and output (the last 80 lines of combined stdout/stderr, verbatim).`,
    { label: `run: ${label}`, schema: RUN_SCHEMA, model: 'haiku', effort: 'low' },
  )
  return res || { exitCode: 1, output: 'runner returned nothing' }
}

// Role agents: plugin agent type first; fall back to a generic agent that loads the role file.
async function role(name, prompt, label, schema) {
  const opts = schema ? { label, schema } : { label }
  try {
    const r = await agent(prompt, { ...opts, agentType: `${NS}:${name}` })
    if (r !== null) return r
  } catch (e) {
    log(`agent type ${NS}:${name} unavailable (${e}) — using role file`)
  }
  return agent(`You are the Oracul ${name}. First read ${A.engine}/agents/${name}.md and follow it exactly (also load the skills it names).\n\n${prompt}`, opts)
}

const note = (title, body) => sh(`mkdir -p "${sliceDir}" && cat >> "${sliceDir}/rounds.md" <<'ORACUL_EOF'\n\n## ${title}\n${body}\nORACUL_EOF`, `note ${title}`)
// Official E2E: subStep e2e (the only subStep the hook lets run Playwright) + the locked stack run, in one command.
// Exit 3 / "STACK BUSY" = another stack operation holds the lock — infrastructure, not code: rerun once, never triage.
const isBusy = (r) => r.exitCode === 3 || /STACK BUSY/.test(r.output || '')
async function e2eRun(label) {
  const cmd = `${node('bin/state.mjs', 'set subStep e2e')} && ${node('bin/stack.mjs', 'e2e')}`
  let r = await sh(cmd, label)
  if (isBusy(r)) { log('stack busy — rerunning E2E once'); r = await sh(cmd, `${label} (stack busy, retry)`) }
  return { ...r, busy: isBusy(r) }
}
const failureBlock = (out) => (String(out || '').match(/==== E2E FAILURES[\s\S]*?==== END E2E FAILURES ====/) || [''])[0]
const NO_E2E = 'Do not run Playwright, docker compose or stack.mjs up/down/e2e — the workflow\'s E2E step runs them (hook-enforced). Unit/integration tests (./gradlew test, npm run test:ci) are fine. For E2E failures read the E2E FAILURES block you were given.'
const TESTER_E2E = `For an E2E test in the list, read the E2E FAILURES block and its trace first. You may verify your repair once or twice with ${node('bin/stack.mjs', 'e2e --scratch --grep <spec file>')} (Bash, foreground, timeout 600000; it waits for the lock and takes minutes). Never run Playwright directly. Scratch results are not evidence — the workflow's E2E step decides.`

const isTest = (f) => /(^|\/)(backend\/src\/test\/|e2e\/tests\/)|\.spec\.ts$/.test(f || '')
const list = (ps) => ps.map((p) => `- ${p.file}: ${p.problem}`).join('\n')

// Decide who fixes a failing gate: the tester (test is broken or contradicts the spec) or the builders (code).
async function triage(gate, output, hints, round) {
  const t = await agent(`${CTX}\n\nThe ${gate} gate of slice ${S} failed in round ${round}. Decide for every failure whether the CODE or the TEST is wrong. Read the specs, the failing tests and the code; change nothing.\n- TEST is wrong only when the test itself is broken (does not compile, flaky timing, shared data, selector/testid not in the spec) or asserts something the spec/contract does not say (including behaviour a later spec changed).\n- Otherwise the CODE is wrong — a test that matches the spec is never the problem.\n\nBuilders flagged these tests as suspicious (hints, not verdicts):\n${hints.length ? list(hints) : '(none)'}\n\nFailure output:\n\`\`\`\n${output.slice(-6000)}\n\`\`\`\n\nReturn code = the failures the builders must fix, as precise instructions with the relevant output lines ("" if none), and tests = the test files the tester must repair, each with the reason.`, { label: `triage: ${gate} ${S} r${round}`, schema: TRIAGE_SCHEMA })
  if (!t || (!t.code && !t.tests.length)) return { code: `${gate} is RED:\n${output}`, tests: [] }
  return t
}

// ================================================================ stage red
if (A.stage === 'red') {
  phase('Spec')
  if (!A.redFeedback) {
    await sh(`${node('bin/state.mjs', `set slice ${S}`)} && ${node('bin/state.mjs', `slice ${S} IN_PROGRESS`)} && ${node('bin/state.mjs', 'set subStep spec')}`, 'state → spec')
    await role('analyst', `${CTX}\n\nStep 4a — slice spec delta for ${S}. Make the spec(s) covering ${FRS} and api/openapi.yaml precise enough to write failing tests without guessing (paths, payloads, statuses, ApiError.code values, UI route, data-testid names). Every FR of the slice must get the line "- Changes earlier behaviour: none | <old> → <new> (tests: <app-relative test files> | none)" — find those tests by grepping the existing tests for every path, field, error code, data-testid, ordering and outbound call this slice changes — and the line "- Ranges & invariants: none | <input ranges with valid/invalid classes, rules that must hold for all data>". Done when ${node('checks/check-artifacts.mjs', `--step 04_build --slice ${S} --stage spec`)} exits 0. Do not touch code or tests.`, `analyst: spec ${S}`)
  }
  phase('Red')
  await sh(node('bin/state.mjs', 'set subStep red'), 'state → red')
  const extra = A.redFeedback ? `\n\nThe previous attempt was rejected by red-check:\n${A.redFeedback}\nFix every NOT-RED / WRONG-REASON problem it lists so the tests compile and fail only because the behaviour is missing.` : ''
  await role('tester', `${CTX}\n\nStep 4b — write the RED tests for slice ${S} (FRs ${FRS}), including the Playwright E2E test for every FR with "UI: yes". Tag every test "// @trace FR-x". Every test file the spec lists under "Changes earlier behaviour (tests: …)" is outdated: update it to the new spec now, keep its @trace tags (also any other test that now contradicts the spec), and list them in your final message. Every FR with "Ranges & invariants" other than none gets a parameterized/exhaustive test over the whole range. Self-check before finishing: run ${node('bin/red-check.mjs', `--slice ${S}`)} yourself (Bash, foreground, timeout 600000) until it prints RESULT: RED, then read every failure message and fix every test that fails for a reason other than missing behaviour (type mismatch, unscripted stubs, state leaking between tests, stale counters, unfinished async work) — the builders cannot change tests.${extra}`, `tester: red ${S}${A.redFeedback ? ' (retry)' : ''}`)
  return { stage: 'red', slice: S, next: `node "${A.engine}/bin/red-check.mjs" --slice ${S}` }
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
while (status === 'GREEN-PENDING' && rounds < MAX) {
  rounds++
  await sh(node('bin/state.mjs', 'round +1'), `round ${rounds}`)

  if (work.tests.length) {
    await sh(node('bin/state.mjs', 'set subStep test-fix'), `state → test-fix r${rounds}`)
    await role('tester', `${CTX}\n\nFix round ${rounds} — repair these tests of slice ${S} (production code is locked for you):\n${list(work.tests)}\n\nThe spec and contract are the authority: make each test assert exactly what they say. Never weaken an assertion just to make it pass, never delete a test of an FR that is still valid, keep every @trace tag. Run the affected tests before finishing. ${TESTER_E2E}${e2eFailures ? `\n\n${e2eFailures}` : ''}`, `tester: fix ${S} r${rounds}`)
  }
  let hints = []
  if (work.code) {
    await sh(node('bin/state.mjs', 'set subStep green'), `state → green r${rounds}`)
    const task = rounds === 1 ? work.code : `Fix round ${rounds}. Fix exactly these problems:\n${work.code}`
    const tail = `\n\nTests are locked for you. If you believe a test is wrong (contradicts the spec, broken, flaky), do not work around it — report it in testProblems; the tester fixes tests. ${NO_E2E}${e2eFailures ? `\n\n${e2eFailures}` : ''}`
    const rs = await parallel([
      () => role('backend-builder', `${CTX}\n\nStep 4c — backend for ${S}. ${task}${tail}`, `backend: ${S} r${rounds}`, BUILDER_SCHEMA),
      () => role('frontend-builder', `${CTX}\n\nStep 4c — frontend for ${S}. ${task}${tail}`, `frontend: ${S} r${rounds}`, BUILDER_SCHEMA),
    ])
    hints = rs.filter(Boolean).flatMap((r) => r.testProblems || [])
  }
  await sh(node('bin/state.mjs', 'set subStep green'), `state → green r${rounds}`)
  e2eFailures = ''

  const v = await sh(node('checks/verify.mjs'), `verify r${rounds}`)
  if (v.exitCode !== 0) {
    failing = ['verify']
    feedback = `verify is RED:\n${v.output}`
    work = await triage('verify', v.output, hints, rounds)
    await note(`Round ${rounds}`, `- Trigger: verify RED\n- To builders: ${work.code ? 'yes' : 'no'} · to tester: ${work.tests.map((t) => t.file).join(', ') || 'no'}\n- Output:\n\n\`\`\`\n${v.output.slice(-3000)}\n\`\`\``)
    continue
  }

  const e = await e2eRun(`docker up + e2e r${rounds}`)
  if (e.busy) {
    failing = ['e2e: stack busy']
    feedback = `Another stack operation held the lock twice in a row (not a code failure):\n${e.output}`
    await note(`Round ${rounds}`, `- Trigger: E2E could not run — stack busy (lock held by another operation), not triaged\n- Output:\n\n\`\`\`\n${e.output.slice(-1500)}\n\`\`\``)
    break
  }
  if (e.exitCode !== 0) {
    failing = ['e2e']
    feedback = `Playwright E2E against the Docker stack failed:\n${e.output}`
    e2eFailures = failureBlock(e.output)
    await sh(node('bin/state.mjs', 'set subStep green'), `state → green r${rounds} (after e2e)`)
    work = await triage('E2E (Playwright against the Docker stack, rebuilt with docker compose up --build)', e.output, hints, rounds)
    await note(`Round ${rounds}`, `- Trigger: E2E RED\n- To builders: ${work.code ? 'yes' : 'no'} · to tester: ${work.tests.map((t) => t.file).join(', ') || 'no'}\n- Output:\n\n\`\`\`\n${e.output.slice(-3000)}\n\`\`\``)
    continue
  }

  await sh(node('bin/state.mjs', 'set subStep review'), `state → review r${rounds}`)
  const flagged = hints.length ? `\n\nThe builders flagged these tests as possibly wrong — judge them under dimension "tests":\n${list(hints)}` : ''
  const rv = await role('reviewer', `${CTX}\n\nStep 4e — review slice ${S}, round ${rounds}. The uncommitted changes are the slice work: git -C "${A.appDir}" status / diff HEAD. Verify and E2E are GREEN. Write ${sliceDir}/review-findings.json with "round": ${rounds}. Return the findings that are still open with severity high or medium (the same ones as in the file).${flagged}`, `reviewer: ${S} r${rounds}`, REVIEW_SCHEMA)
  const c = await sh(node('checks/check-review.mjs', `--slice ${S}`), `check-review r${rounds}`)
  if (c.exitCode === 0) { status = 'DONE'; failing = []; break }
  failing = ['review']
  feedback = `Review findings (open high/medium in ${sliceDir}/review-findings.json):\n${c.output}`
  const open = (rv && rv.open) || []
  const testFindings = open.filter((f) => f.dimension === 'tests' || isTest(f.file))
  const codeFindings = open.filter((f) => !testFindings.includes(f))
  work = open.length
    ? {
        code: codeFindings.length ? `Review findings (${sliceDir}/review-findings.json):\n${codeFindings.map((f) => `- ${f.id} [${f.severity}] ${f.file}: ${f.problem}${f.fix ? ` — fix: ${f.fix}` : ''}`).join('\n')}` : '',
        tests: testFindings.map((f) => ({ file: f.file, problem: `${f.id} [${f.severity}] ${f.problem}${f.fix ? ` — fix: ${f.fix}` : ''}` })),
      }
    : { code: `${feedback}\nRead the open findings in the file; findings about tests are for the tester — report them in testProblems.`, tests: [] }
  await note(`Round ${rounds}`, `- Trigger: review not clean\n- To builders: ${codeFindings.map((f) => f.id).join(', ') || (open.length ? 'none' : 'all (findings not returned)')} · to tester: ${testFindings.map((f) => f.id).join(', ') || 'none'}\n- ${c.output.split('\n').filter((l) => /INVALID|MISSING/.test(l)).join('\n- ')}`)
}
if (status === 'GREEN-PENDING') status = 'BLOCKED'

// ---------------------------------------------------------------- Close
phase('Close')
if (status === 'DONE') {
  const close = await sh([
    node('bin/state.mjs', `slice ${S} DONE`),
    node('bin/state.mjs', 'set subStep none'),
    node('checks/check-coverage.mjs', '--update'),
    node('checks/check-artifacts.mjs', `--step 04_build --slice ${S} --stage done`),
    node('bin/commit.mjs', `--message "${A.phase} ${S}: done (${FRS})"`),
  ].join(' && '), `close ${S}`)
  if (close.exitCode !== 0) { status = 'BLOCKED'; failing = ['close: artifacts/coverage'] ; feedback = close.output }
  else return { status, slice: S, rounds, failing: [], output: close.output.slice(-1500) }
}

// BLOCKED: write the failure note, park the code, keep the docs, decide CONTINUE/STOP.
await agent(`Write ${sliceDir}/failure-note.md for the Oracul slice ${S} (FRs ${FRS}) using the template ${A.engine}/templates/docs/failure-note.md.\nFacts (use only these and the files ${sliceDir}/rounds.md, ${sliceDir}/red-evidence.md, ${sliceDir}/review-findings.json if present):\n- rounds used: ${rounds} of ${MAX}\n- failing: ${failing.join(', ')}\n- last output:\n${(feedback || red.output || '').slice(-3000)}\nKeep the heading "## What failed". Write only that one file.`, { label: `failure note ${S}` })
const park = await sh([
  node('bin/state.mjs', `slice ${S} BLOCKED`),
  node('bin/state.mjs', 'set subStep none'),
  `git -C "${A.appDir}" checkout HEAD -- backend frontend e2e api`,
  `git -C "${A.appDir}" clean -fdq -- backend/src frontend/src e2e/tests`,
  node('bin/commit.mjs', `--message "${A.phase} ${S}: BLOCKED after ${rounds} round(s) — docs only (${FRS})"`),
  node('bin/state.mjs', `impact ${S}`),
].join(' && '), `park ${S}`)
const m = park.output.match(/\{"slice".*\}/)
const impact = m ? JSON.parse(m[0]) : { decision: 'STOP', dependents: ['unknown — impact not readable'] }
return { status: 'BLOCKED', slice: S, rounds, failing, decision: impact.decision, dependents: impact.dependents }
