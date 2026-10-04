export const meta = {
  name: 'oracul-finish-and-run',
  description: 'Oracul Step 5: full verify, independent whole-app review (fix loop ≤5), Docker stack + Playwright E2E with screenshots, generated traceability, QA pack, artifact check, commit — app left running',
  phases: [
    { title: 'Verify + Review', detail: 'full verify and whole-app review; code fixes by builders, test fixes by the tester' },
    { title: 'Run + E2E', detail: 'docker compose up, Playwright against the stack' },
    { title: 'QA', detail: 'gen-traceability, qa-documenter, check-artifacts 05_release' },
    { title: 'Finish', detail: 'final verify, commit, report' },
  ],
}

// args: { engine, root, app, appDir, phase, phaseDir, agentNs?: 'oracul', maxRounds?: 5 }
const A = args || {}
const need = ['engine', 'root', 'app', 'appDir', 'phase', 'phaseDir']
const missing = need.filter((k) => !A[k])
if (missing.length) return { error: `finish-and-run: missing args ${missing.join(', ')} — args did not reach the script` }

const NS = A.agentNs || 'oracul'
const MAX = A.maxRounds || 5
const node = (script, rest) => `node "${A.engine}/${script}" ${rest || ''}`.trim()
const rel = `${A.phaseDir}/05_release`
const CTX = `App: ${A.appDir}\nPhase docs: ${A.phaseDir}\nRelease folder: ${rel}\nContract: ${A.appDir}/api/openapi.yaml\nEngine (read-only): ${A.engine}`

const RUN_SCHEMA = {
  type: 'object',
  properties: { exitCode: { type: 'integer' }, output: { type: 'string' } },
  required: ['exitCode', 'output'],
}
const PROBLEMS = { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, problem: { type: 'string' } }, required: ['file', 'problem'] } }
const BUILDER_SCHEMA = { type: 'object', properties: { summary: { type: 'string' }, testProblems: PROBLEMS }, required: ['summary', 'testProblems'] }
const TRIAGE_SCHEMA = { type: 'object', properties: { code: { type: 'string' }, layers: { type: 'array', items: { type: 'string', enum: ['backend', 'frontend'] } }, tests: PROBLEMS }, required: ['code', 'tests'] }
// Which builders a code fix needs: "unknown" → both; otherwise only the failing layer(s).
const LAYERS = ['backend', 'frontend']
const builderLayers = (w) => { const l = (w.layers || []).filter((x) => LAYERS.includes(x)); return l.length ? [...new Set(l)] : LAYERS }
const layerOfFile = (f) => (/^backend\//.test(f || '') ? 'backend' : /^frontend\//.test(f || '') ? 'frontend' : null)
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
// Infrastructure failures are never code failures: no triage, no fix round. null = a real result.
function infraReason(r) {
  const out = r.output || ''
  if (r.exitCode === 3 || /STACK BUSY/.test(out)) return 'stack busy'
  if (isGuardBlock(r)) return 'blocked by guard hook'
  if (r.exitCode === 125) return 'runner returned no exit code'
  if (r.exitCode === 124) return 'timed out'
  if (r.exitCode === 4 || /E2E WORKER LOST/.test(out)) return 'e2e worker lost'
  return null
}
// The command is fenced with more backticks than any run inside it: note() bodies contain ``` blocks, and a plain
// ``` fence ended the command early for the runner model.
const fenceFor = (cmd) => '`'.repeat(Math.max(3, ...[...String(cmd).matchAll(/`+/g)].map((m) => m[0].length + 1)))
async function runOnce(cmd, label) {
  const f = fenceFor(cmd)
  const res = await agent(
    `Run exactly this shell command from the directory ${A.root} and report the result. Use the Bash tool in the foreground with timeout 600000 (never run_in_background). Do not modify files yourself, do not retry, do not try to fix anything. If the command times out, report exitCode 124. The command is everything between the two ${f} fence lines — run all of it, unchanged, as ONE Bash call.\n\n${f}bash\n${cmd}\n${f}\n\nReturn exitCode (the command's real exit status) and output (the last 80 lines of combined stdout/stderr, verbatim).`,
    { label: `run: ${label}`, schema: RUN_SCHEMA, model: 'haiku', effort: 'low' },
  )
  return res || { exitCode: 1, output: 'runner returned nothing' }
}
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
// Official E2E, three kinds of call so none comes near the runner's 10-minute limit (the suite alone took 9.5 min):
//   1. `set subStep e2e && stack.mjs up` (docker build; subStep e2e is the only one the hook lets run the stack)
//   2. `stack.mjs e2e --detach` — Playwright starts in a background worker that holds the stack lock
//   3. `stack.mjs e2e-wait --max 480`, repeated while it answers 75 (still running), up to E2E_WAITS times
// "stack busy" on 1 or 2 is rerun once; anything else infrastructure-like ends up in infraReason().
const E2E_WAITS = 8
async function e2eRun(label) {
  const retryBusy = async (cmd, l) => {
    let r = await sh(cmd, l, { gate: true })
    if (infraReason(r) === 'stack busy') { log(`${l}: stack busy — rerunning once`); r = await sh(cmd, `${l} (stack busy, retry)`, { gate: true }) }
    return r
  }
  const up = await retryBusy(`${node('bin/state.mjs', 'set subStep e2e')} && ${node('bin/stack.mjs', 'up')}`, `${label}: docker up`)
  if (up.exitCode !== 0) return { ...up, infra: infraReason(up) }
  const start = await retryBusy(node('bin/stack.mjs', 'e2e --detach'), `${label}: start Playwright`)
  if (start.exitCode !== 0) return { ...start, infra: infraReason(start) }
  for (let i = 1; i <= E2E_WAITS; i++) {
    const w = await sh(node('bin/stack.mjs', 'e2e-wait --max 480'), `${label}: wait ${i}`, { gate: true })
    if (w.exitCode !== 75) return { ...w, infra: infraReason(w) }
  }
  return { exitCode: 124, output: `E2E still running after ${E2E_WAITS} waits of 480 s`, infra: 'timed out' }
}
const failureBlock = (out) => (String(out || '').match(/==== E2E FAILURES[\s\S]*?==== END E2E FAILURES ====/) || [''])[0]
const NO_E2E = 'Do not run Playwright, docker compose or stack.mjs up/down/e2e — the workflow\'s E2E step runs them (hook-enforced). Unit/integration tests (./gradlew test, npm run test:ci) are fine. For E2E failures read the E2E FAILURES block you were given.'
const TESTER_E2E = `For an E2E test in the list, read the E2E FAILURES block and its trace first. You may verify your repair once or twice with ${node('bin/stack.mjs', 'e2e --scratch --grep <spec file>')} (Bash, foreground, timeout 600000; it waits for the lock and takes minutes). Never run Playwright directly. Scratch results are not evidence — the workflow's E2E step decides.`
let e2eFailures = '' // E2E FAILURES block of the last official run, forwarded unchanged to the fix round

const isTest = (f) => /(^|\/)(backend\/src\/test\/|e2e\/tests\/)|\.spec\.ts$/.test(f || '')
const list = (ps) => ps.map((p) => `- ${p.file}: ${p.problem}`).join('\n')
let hints = [] // tests the builders flagged as possibly wrong in the last fix round

// Decide who fixes a failing gate: the tester (test is broken or contradicts the spec) or the builders (code).
async function triage(gate, output, round) {
  const t = await agent(`${CTX}\n\nThe ${gate} gate of the release failed in round ${round}. Decide for every failure whether the CODE or the TEST is wrong. Read the specs, the failing tests and the code; change nothing.\n- TEST is wrong only when the test itself is broken (does not compile, flaky timing, shared data, selector/testid not in the spec) or asserts something the spec/contract does not say (including behaviour a later spec changed).\n- Otherwise the CODE is wrong — a test that matches the spec is never the problem.\n\nBuilders flagged these tests as suspicious (hints, not verdicts):\n${hints.length ? list(hints) : '(none)'}\n\nFailure output:\n\`\`\`\n${output.slice(-6000)}\n\`\`\`\n\nReturn code = the failures the builders must fix, as precise instructions with the relevant output lines ("" if none), layers = which builders that code fix needs ("backend", "frontend" or both; leave empty if unsure), and tests = the test files the tester must repair, each with the reason.`, { label: `triage: ${gate} r${round}`, schema: TRIAGE_SCHEMA })
  if (!t || (!t.code && !t.tests.length)) return { code: `${gate} is RED:\n${output}`, tests: [] }
  return t
}
// Review findings about tests go to the tester, the rest to the builders.
function routeReview(rv, checkOutput) {
  const open = (rv && rv.open) || []
  if (!open.length) return { code: `Release review findings (open high/medium in ${rel}/review-findings.json):\n${checkOutput}\nFindings about tests are for the tester — report them in testProblems.`, tests: [] }
  const tests = open.filter((f) => f.dimension === 'tests' || isTest(f.file))
  const code = open.filter((f) => !tests.includes(f))
  const fmt = (f) => `${f.id} [${f.severity}] ${f.problem}${f.fix ? ` — fix: ${f.fix}` : ''}`
  const layers = code.map((f) => layerOfFile(f.file))
  return {
    code: code.length ? `Release review findings (${rel}/review-findings.json):\n${code.map((f) => `- ${f.file}: ${fmt(f)}`).join('\n')}` : '',
    layers: layers.includes(null) ? [] : layers,
    tests: tests.map((f) => ({ file: f.file, problem: fmt(f) })),
  }
}
// One fix round: tester repairs tests (code locked), then builders fix code (tests locked).
async function fix(round, work) {
  await sh(node('bin/state.mjs', 'round +1'), `round ${round}`)
  if (work.tests.length) {
    await sh(node('bin/state.mjs', 'set subStep test-fix'), `state → test-fix r${round}`)
    await role('tester', `${CTX}\n\nRelease fix round ${round} — repair these tests (production code is locked for you):\n${list(work.tests)}\n\nThe spec and contract are the authority: make each test assert exactly what they say. Never weaken an assertion just to make it pass, never delete a test of an FR that is still valid, keep every @trace tag. Run the affected tests before finishing. ${TESTER_E2E}${e2eFailures ? `\n\n${e2eFailures}` : ''}`, `tester fix r${round}`)
  }
  await sh(node('bin/state.mjs', 'set subStep green'), `state → green r${round}`)
  hints = []
  if (!work.code) return
  const task = `Release fix round ${round}. Fix exactly these problems (tests and contract are locked for you; if you believe a test is wrong, report it in testProblems — the tester fixes tests). ${NO_E2E}\n${work.code}${e2eFailures ? `\n\n${e2eFailures}` : ''}`
  const rs = await parallel(builderLayers(work).map((layer) => () => role(`${layer}-builder`, `${CTX}\n\n${task}`, `${layer} fix r${round}`, BUILDER_SCHEMA)))
  hints = rs.filter(Boolean).flatMap((r) => r.testProblems || [])
}

const report = { status: 'GREEN', rounds: 0, problems: [] }

// ---------------------------------------------------------------- Verify + Review
phase('Verify + Review')
await sh(`${node('bin/state.mjs', 'set step 05_release')} && ${node('bin/state.mjs', 'set slice none')} && ${node('bin/state.mjs', 'set subStep none')}`, 'state → 05_release')
let clean = false
let infraStop = null // verify/review could not run: E2E, QA and the release commit would only add noise
for (let r = 1; r <= MAX && !clean; r++) {
  report.rounds = r
  const v = await sh(node('checks/verify.mjs', '--scope all'), `verify all r${r}`, { gate: true })
  if (infraReason(v)) { infraStop = `verify: ${infraReason(v)}`; break }
  if (v.exitCode !== 0) { if (r < MAX) await fix(r, await triage('verify --scope all', v.output, r)); report.problems = ['verify']; continue }
  await sh(node('bin/state.mjs', 'set subStep review'), `state → review r${r}`)
  const flagged = hints.length ? `\n\nThe builders flagged these tests as possibly wrong — judge them under dimension "tests":\n${list(hints)}` : ''
  const rv = await role('reviewer', `${CTX}\n\nRelease review (whole app, all phases), round ${r}. Write ${rel}/review-findings.json with "slice": "release", "round": ${r}. Focus on cross-slice integration, error handling, security, and FRs that may have regressed. Return the findings that are still open with severity high or medium (the same ones as in the file).${flagged}`, `reviewer: release r${r}`, REVIEW_SCHEMA)
  const c = await sh(node('checks/check-review.mjs', '--release'), `check-review release r${r}`, { gate: true })
  if (infraReason(c)) { infraStop = `release review: ${infraReason(c)}`; break }
  if (c.exitCode === 0) { clean = true; report.problems = []; break }
  report.problems = ['release review']
  if (r < MAX) await fix(r, routeReview(rv, c.output))
}
if (!clean) report.status = 'RED'
if (infraStop) {
  log(`release stopped early: ${infraStop} (infrastructure) — E2E, QA and the release commit skipped`)
  return { ...report, status: 'RED', problems: [infraStop], stoppedEarly: true }
}

// ---------------------------------------------------------------- Run + E2E
phase('Run + E2E')
let e2e = await e2eRun('docker up + e2e')
for (let r = 1; r < MAX && e2e.exitCode !== 0 && !e2e.infra; r++) {
  e2eFailures = failureBlock(e2e.output)
  await sh(node('bin/state.mjs', 'set subStep green'), `state → green (after e2e r${r})`)
  await fix(`e2e-${r}`, await triage('E2E (Playwright against the Docker stack, rebuilt with docker compose up --build)', e2e.output, `e2e-${r}`))
  e2e = await e2eRun(`docker up + e2e r${r + 1}`)
}
e2eFailures = ''
if (e2e.infra) { report.status = 'RED'; report.problems.push(`e2e: ${e2e.infra}`) }
else if (e2e.exitCode !== 0) { report.status = 'RED'; report.problems.push('e2e') }

// ---------------------------------------------------------------- QA
phase('QA')
const trace = await sh(node('checks/gen-traceability.mjs'), 'gen-traceability', { gate: true })
if (trace.exitCode !== 0) { report.status = 'RED'; report.problems.push('traceability has ✘') }
await sh(node('bin/state.mjs', 'set subStep qa'), 'state → qa')
let art = null
for (let attempt = 1; attempt <= 2; attempt++) {
  const extra = art ? `\n\nThe artifact check rejected the pack:\n${art.output}` : ''
  await role('qa-documenter', `${CTX}\n\nWrite the QA pack for ${A.phase} in ${rel}/qa/ (test-plan.md, acceptance-report.md, how-to-run.md). Traceability summary:\n${trace.output}${extra}`, `qa-documenter${attempt > 1 ? ' (retry)' : ''}`)
  art = await sh(node('checks/check-artifacts.mjs', '--step 05_release'), 'check-artifacts 05_release', { gate: true })
  if (art.exitCode === 0) break
}
if (art.exitCode !== 0) { report.status = 'RED'; report.problems.push('release artifacts') }

// ---------------------------------------------------------------- Finish
phase('Finish')
const fin = await sh([
  node('bin/state.mjs', 'set subStep none'),
  node('checks/verify.mjs', '--quick --scope all'),
].join(' && '), 'final verify (quick)', { gate: true })
if (fin.exitCode !== 0) { report.status = 'RED'; report.problems.push('final verify') }
await sh(node('bin/commit.mjs', `--message "${A.phase} 05_release: ${report.status}${report.problems.length ? ` (${report.problems.join(', ')})` : ''}"`), 'commit release')
// Flaky tests (passed only on retry) are reported, never blocking (D8).
const fl = await sh(node('bin/state.mjs', 'flaky'), 'flaky tests')
const flaky = String(fl.output || '').split('\n').filter((l) => /FLAKY /.test(l))

return {
  ...report,
  urls: { frontend: 'http://localhost:4200', backend: 'http://localhost:8080/api', health: 'http://localhost:8080/actuator/health' },
  traceability: trace.output.slice(-600),
  artifacts: art.output.slice(-2000),
  e2e: e2e.output.slice(-1200),
  flaky,
}
