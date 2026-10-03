#!/usr/bin/env node
// Self-test of the engine: every check, the state tool and every hook must FAIL on a red case and PASS on a green case.
// Each case copies fixtures/app-green into a temp sandbox (own apps dir + state dir), applies a mutation, runs a command
// and compares the exit code. Nothing outside the temp sandbox is touched.
//   node self-test/run.mjs            all cases
//   node self-test/run.mjs coverage   only cases whose name contains "coverage"
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ENGINE } from '../checks/lib/core.mjs';
import { analyseRed } from '../checks/lib/red.mjs';
import { acquire } from '../checks/lib/lock.mjs';
import { e2eEnv, failureBlock, scratchEnvProblems, scratchSupported } from '../checks/lib/e2e.mjs';

const FIX = path.join(ENGINE, 'self-test', 'fixtures', 'app-green');
const SPEC = 'docs/phase-01_mvp/02_specs/rooms.md';
const filter = process.argv[2] || '';
const results = [];

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oracul-selftest-'));
  const appDir = path.join(root, 'apps', 'fixture');
  fs.cpSync(FIX, appDir, { recursive: true });
  const rj = path.join(appDir, 'e2e/report/results.json');
  fs.writeFileSync(rj, fs.readFileSync(rj, 'utf8').replace('__E2E_TESTS__', path.join(appDir, 'e2e', 'tests')));
  const stateDir = path.join(root, 'state');
  const st = {
    app: 'fixture', title: 'Fixture', phase: 'phase-01_mvp', phases: ['phase-01_mvp'], step: '05_release', slice: null,
    subStep: 'none', round: 0, slices: { '01_rooms': 'DONE', '02_search': 'DONE' }, approvals: { scope: '2026-10-02', plan: '2026-10-02' },
    lastVerify: { at: new Date(Date.now() + 60_000).toISOString(), result: 'GREEN', failing: [] },
  };
  write(path.join(stateDir, 'apps/fixture/state.json'), JSON.stringify(st, null, 2));
  write(path.join(stateDir, 'active-app.json'), JSON.stringify({ app: 'fixture', phase: 'phase-01_mvp' }));
  const env = { ...process.env, FACTORY_APPS_DIR: path.join(root, 'apps'), FACTORY_STATE_DIR: stateDir };
  const sb = {
    root, appDir, stateDir, env,
    p: (rel) => path.join(appDir, rel),
    doc: (rel) => path.join(appDir, 'docs/phase-01_mvp', rel),
    read: (rel) => fs.readFileSync(path.join(appDir, rel), 'utf8'),
    edit: (rel, from, to) => { const f = path.join(appDir, rel); fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(from, to)); },
    put: (rel, text) => write(path.join(appDir, rel), text),
    rm: (rel) => fs.rmSync(path.join(appDir, rel), { recursive: true, force: true }),
    state: (patch) => {
      const f = path.join(stateDir, 'apps/fixture/state.json');
      fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), ...patch }, null, 2));
    },
    baseline: (b) => write(path.join(stateDir, 'apps/fixture/baseline/coverage.json'), JSON.stringify(b)),
    readBaseline: () => JSON.parse(fs.readFileSync(path.join(stateDir, 'apps/fixture/baseline/coverage.json'), 'utf8')),
  };
  return sb;
}
function write(f, text) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); }

const node = (sb, script, args = [], input) => {
  const r = spawnSync('node', [path.join(ENGINE, script), ...args], { env: sb.env, encoding: 'utf8', input, cwd: sb.root });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
};
const hook = (sb, name, event) => node(sb, `hooks/${name}.mjs`, [], JSON.stringify({ cwd: sb.root, ...event }));

function test(name, expectCode, fn, extra) {
  if (filter && !name.includes(filter)) return;
  const sb = sandbox();
  let res, ok, note = '';
  try {
    res = fn(sb);
    ok = res.code === expectCode;
    if (ok && extra) { const e = extra(sb, res); if (e !== true) { ok = false; note = e; } }
  } catch (e) { ok = false; note = String(e); res = { code: 'ERR', out: '' }; }
  results.push({ name, ok, expectCode, got: res.code, note, out: res.out });
  fs.rmSync(sb.root, { recursive: true, force: true });
}

// ---------------- traceability
test('traceability green (scope all)', 0, (sb) => node(sb, 'checks/check-traceability.mjs', ['--scope', 'all']));
test('traceability red: FR-1 untagged', 1, (sb) => {
  sb.edit('backend/src/test/java/com/oracul/app/rooms/RoomsApiIT.java', '@trace FR-1', 'no tag');
  sb.edit('e2e/tests/rooms.spec.ts', '@trace FR-1', 'no tag');
  return node(sb, 'checks/check-traceability.mjs', ['--scope', 'all']);
});
test('traceability red: tag points at unknown FR-9', 1, (sb) => { sb.edit('e2e/tests/rooms.spec.ts', '@trace FR-1', '@trace FR-1, FR-9'); return node(sb, 'checks/check-traceability.mjs'); });
test('traceability green: BLOCKED slice is shown, not failed', 0, (sb) => {
  sb.state({ slices: { '01_rooms': 'DONE', '02_search': 'BLOCKED' } });
  sb.rm('frontend/src/app/search/search.spec.ts');
  return node(sb, 'checks/check-traceability.mjs', ['--scope', 'all']);
}, (sb, r) => /BLOCKED\s+FR-2/.test(r.out) || 'BLOCKED line missing');
test('traceability green: unbuilt slice skipped in scope built', 0, (sb) => {
  sb.state({ step: '04_build', slices: { '01_rooms': 'DONE', '02_search': 'PENDING' } });
  sb.rm('frontend/src/app/search/search.spec.ts');
  return node(sb, 'checks/check-traceability.mjs');
});

// ---------------- coverage
test('coverage green: at baseline', 0, (sb) => { sb.baseline({ backend: 80, frontend: 75 }); return node(sb, 'checks/check-coverage.mjs'); });
test('coverage red: below baseline', 1, (sb) => { sb.baseline({ backend: 90, frontend: 75 }); return node(sb, 'checks/check-coverage.mjs'); });
test('coverage red: --update refuses to lower', 1, (sb) => { sb.baseline({ backend: 90, frontend: 75 }); return node(sb, 'checks/check-coverage.mjs', ['--update']); },
  (sb) => sb.readBaseline().backend === 90 || 'baseline was changed');
test('coverage green: --update raises', 0, (sb) => { sb.baseline({ backend: 50, frontend: 50 }); return node(sb, 'checks/check-coverage.mjs', ['--update']); },
  (sb) => (sb.readBaseline().backend === 80 && sb.readBaseline().frontend === 75) || `baseline ${JSON.stringify(sb.readBaseline())}`);
test('coverage red: report missing', 1, (sb) => { sb.rm('backend/build/reports'); return node(sb, 'checks/check-coverage.mjs'); });

// ---------------- contract
test('contract green (require generated)', 0, (sb) => node(sb, 'checks/check-contract.mjs', ['--require-generated']));
test('contract red: duplicate operationId', 1, (sb) => { sb.edit('api/openapi.yaml', 'operationId: createRoom', 'operationId: listRooms'); return node(sb, 'checks/check-contract.mjs'); });
test('contract red: compile does not depend on generation', 1, (sb) => { sb.edit('backend/build.gradle.kts', 'tasks.compileJava { dependsOn(tasks.openApiGenerate) }', ''); return node(sb, 'checks/check-contract.mjs'); });
test('contract red: frontend test does not regenerate client', 1, (sb) => { sb.edit('frontend/package.json', '"pretest": "npm run generate:api",', ''); return node(sb, 'checks/check-contract.mjs'); });
test('contract red: generated code missing', 1, (sb) => { sb.rm('frontend/src/app/api'); return node(sb, 'checks/check-contract.mjs', ['--require-generated']); });

// ---------------- review
test('review green: slices + release', 0, (sb) => {
  const a = node(sb, 'checks/check-review.mjs');
  const b = node(sb, 'checks/check-review.mjs', ['--release']);
  return { code: a.code || b.code, out: a.out + b.out };
});
test('review red: open high finding', 1, (sb) => {
  sb.put('docs/phase-01_mvp/05_release/review-findings.json', JSON.stringify({ round: 2, findings: [{ id: 'R1', severity: 'high', status: 'open' }] }));
  return node(sb, 'checks/check-review.mjs', ['--release']);
});
test('review red: review file missing', 1, (sb) => { sb.rm('docs/phase-01_mvp/04_build/01_rooms/review-findings.json'); return node(sb, 'checks/check-review.mjs'); });

// ---------------- artifacts
for (const step of ['00_setup', '01_scope', '02_specs', '03_plan', '04_build', '05_release']) {
  test(`artifacts green: ${step}`, 0, (sb) => {
    if (step === '05_release') { // traceability.md is never handwritten — generate it like the release workflow does
      sb.put('../../state/apps/fixture/last-run.json', JSON.stringify({ layers: { backend: { exit: 0 }, frontend: { exit: 0 } } }));
      const g = node(sb, 'checks/gen-traceability.mjs');
      if (g.code) return g;
    }
    return node(sb, 'checks/check-artifacts.mjs', ['--step', step]);
  });
}
test('artifacts red: scope not approved', 1, (sb) => { sb.edit('docs/phase-01_mvp/01_scope/requirements.md', /^Status:.*$/m, 'Status: DRAFT'); return node(sb, 'checks/check-artifacts.mjs', ['--step', '01_scope']); });
test('artifacts red: FR without acceptance criteria', 1, (sb) => {
  sb.edit('docs/phase-01_mvp/01_scope/requirements.md', '  - Given rooms Orion and Vega, when I search "Or", then only Orion is returned\n', '');
  return node(sb, 'checks/check-artifacts.mjs', ['--step', '01_scope']);
});
test('artifacts red: FR in two specs', 1, (sb) => { sb.put('docs/phase-01_mvp/02_specs/search.md', '# Spec\n\nCovers: FR-2\n'); return node(sb, 'checks/check-artifacts.mjs', ['--step', '02_specs']); });
test('artifacts red: plan dependency cycle', 1, (sb) => { sb.edit('docs/phase-01_mvp/03_plan/plan.md', '| 01_rooms | FR-1 | — |', '| 01_rooms | FR-1 | 02_search |'); return node(sb, 'checks/check-artifacts.mjs', ['--step', '03_plan']); });
test('artifacts red: plan misses an FR', 1, (sb) => { sb.edit('docs/phase-01_mvp/03_plan/plan.md', '| 02_search | FR-2 |', '| 02_search | — |'); return node(sb, 'checks/check-artifacts.mjs', ['--step', '03_plan']); });
test('artifacts red: slice without red evidence', 1, (sb) => { sb.rm('docs/phase-01_mvp/04_build/01_rooms/red-evidence.md'); return node(sb, 'checks/check-artifacts.mjs', ['--step', '04_build']); });
test('artifacts red: BLOCKED slice without failure note', 1, (sb) => { sb.state({ slices: { '01_rooms': 'DONE', '02_search': 'BLOCKED' } }); return node(sb, 'checks/check-artifacts.mjs', ['--step', '04_build']); });
test('artifacts green: BLOCKED slice with failure note + rounds', 0, (sb) => {
  sb.state({ slices: { '01_rooms': 'DONE', '02_search': 'BLOCKED' } });
  sb.put('docs/phase-01_mvp/04_build/02_search/failure-note.md', '# Failure note\n\n## What failed\nverify RED\n');
  sb.put('docs/phase-01_mvp/04_build/02_search/rounds.md', '# Rounds\n\n## Round 1\n...\n');
  return node(sb, 'checks/check-artifacts.mjs', ['--step', '04_build']);
});
test('artifacts red: UI FR without screenshot', 1, (sb) => { sb.rm('docs/phase-01_mvp/05_release/qa/screenshots/FR-1-room-created.png'); return node(sb, 'checks/check-artifacts.mjs', ['--step', '05_release']); });
test('artifacts red: ✔ without evidence link', 1, (sb) => { sb.edit('docs/phase-01_mvp/05_release/qa/acceptance-report.md', '[traceability](traceability.md)', 'see traceability'); return node(sb, 'checks/check-artifacts.mjs', ['--step', '05_release']); });
test('artifacts red: failing E2E report', 1, (sb) => { sb.edit('e2e/report/results.json', '"unexpected": 0', '"unexpected": 1'); return node(sb, 'checks/check-artifacts.mjs', ['--step', '05_release']); });
test('artifacts red: handwritten traceability', 1, (sb) => { sb.put('docs/phase-01_mvp/05_release/qa/traceability.md', '# Traceability\nFR-1 ✔ FR-2 ✔\n'); return node(sb, 'checks/check-artifacts.mjs', ['--step', '05_release']); });

test('artifacts green: slice spec delta (stage spec)', 0, (sb) => node(sb, 'checks/check-artifacts.mjs', ['--step', '04_build', '--slice', '01_rooms', '--stage', 'spec']));
test('artifacts red: slice FR lacks "Changes earlier behaviour"', 1, (sb) => {
  sb.edit(SPEC, '- Changes earlier behaviour: none\n', '');
  return node(sb, 'checks/check-artifacts.mjs', ['--step', '04_build', '--slice', '01_rooms', '--stage', 'spec']);
});
test('artifacts red: slice FR lacks "Ranges & invariants"', 1, (sb) => {
  sb.edit(SPEC, '- Ranges & invariants: none\n', '');
  return node(sb, 'checks/check-artifacts.mjs', ['--step', '04_build', '--slice', '01_rooms', '--stage', 'spec']);
});
test('artifacts red: superseded test file does not exist', 1, (sb) => {
  sb.edit(SPEC, '- Changes earlier behaviour: none', '- Changes earlier behaviour: 201 → 200 (tests: backend/src/test/java/com/oracul/app/rooms/GoneIT.java)');
  return node(sb, 'checks/check-artifacts.mjs', ['--step', '04_build', '--slice', '01_rooms', '--stage', 'done']);
});
test('artifacts red: change names no tests', 1, (sb) => {
  sb.edit(SPEC, '- Changes earlier behaviour: none', '- Changes earlier behaviour: list unsorted → sorted by rank');
  return node(sb, 'checks/check-artifacts.mjs', ['--step', '04_build', '--slice', '01_rooms', '--stage', 'spec']);
});
test('artifacts green: change names an existing test', 0, (sb) => {
  sb.edit(SPEC, '- Changes earlier behaviour: none', '- Changes earlier behaviour: 201 → 200 (tests: backend/src/test/java/com/oracul/app/rooms/RoomsApiIT.java#createsRoom)');
  return node(sb, 'checks/check-artifacts.mjs', ['--step', '04_build', '--slice', '01_rooms', '--stage', 'spec']);
});
test('artifacts green: 04_build sweep does not re-check spec lines of finished slices', 0, (sb) => {
  sb.edit(SPEC, '- Ranges & invariants: none\n', '');
  return node(sb, 'checks/check-artifacts.mjs', ['--step', '04_build']);
});

// ---------------- red analysis (bin/red-check.mjs without Gradle: synthetic layer outputs + JUnit XML)
const OLD = 'backend/src/test/java/com/oracul/app/old/OldIT.java';
const ASSERT = '<failure type="org.opentest4j.AssertionFailedError" message="Status expected:&lt;201&gt; but was:&lt;501&gt;">trace</failure>';
const junit = (sb, cls, failure) => sb.put(`backend/build/test-results/test/TEST-${cls}.xml`,
  `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="${cls}" tests="1" failures="1" errors="0">\n  <testcase name="t()" classname="${cls}" time="0.1">${failure}</testcase>\n</testsuite>\n`);
const roomsFails = (sb, failure = ASSERT) => junit(sb, 'com.oracul.app.rooms.RoomsApiIT', failure);
const red = (sb, opts = {}) => {
  const a = analyseRed({ appDir: sb.appDir, phaseDir: sb.doc(''), slice: '01_rooms', layers: { backend: { code: 1, out: 'BUILD FAILED' } }, changed: [], ...opts });
  return { code: a.verdict === 'RED' ? 0 : a.verdict === 'WRONG-REASON' ? 2 : 1, out: [a.verdict, ...a.notRed, ...a.wrong].join('\n') };
};
const oldTest = (sb) => { sb.put(OLD, 'package com.oracul.app.old;\nclass OldIT { @org.junit.jupiter.api.Test void t() {} }\n'); junit(sb, 'com.oracul.app.old.OldIT', ASSERT); };
test('red green: slice test fails on an assertion', 0, (sb) => { roomsFails(sb); return red(sb); });
test('red red: all tests pass', 1, (sb) => red(sb, { layers: { backend: { code: 0, out: 'BUILD SUCCESSFUL' } } }));
test('red red: compile error', 2, (sb) => red(sb, { layers: { backend: { code: 1, out: '> Task :compileTestJava FAILED' } } }));
test('red red: int vs long — expected and actual print the same', 2, (sb) => {
  roomsFails(sb, '<failure type="java.lang.AssertionError" message="JSON path &quot;$.capacity&quot; expected:&lt;8&gt; but was:&lt;8&gt;">trace</failure>');
  return red(sb);
});
test('red red: JUnit 5 type-mismatch message', 2, (sb) => {
  roomsFails(sb, '<failure type="org.opentest4j.AssertionFailedError" message="expected: java.lang.Long@1f &lt;8&gt; but was: java.lang.Integer@2a &lt;8&gt;"/>');
  return red(sb);
});
test('red red: Mockito unnecessary stubbing', 2, (sb) => {
  roomsFails(sb, '<error type="org.mockito.exceptions.misusing.UnnecessaryStubbingException" message="Unnecessary stubbings detected.">trace</error>');
  return red(sb);
});
test('red red: older test broken by the new tests (leak)', 2, (sb) => { roomsFails(sb); oldTest(sb); return red(sb); });
test('red green: older test the tester updated may fail', 0, (sb) => { roomsFails(sb); oldTest(sb); return red(sb, { changed: [OLD] }); });
test('red green: stale report of an older test is ignored', 0, (sb) => {
  roomsFails(sb); oldTest(sb);
  const f = sb.p('backend/build/test-results/test/TEST-com.oracul.app.old.OldIT.xml');
  fs.utimesSync(f, new Date(0), new Date(0));
  return red(sb, { since: 1000 });
});
test('red red: superseded test not updated', 1, (sb) => {
  roomsFails(sb); oldTest(sb);
  sb.edit(SPEC, '- Changes earlier behaviour: none', `- Changes earlier behaviour: 201 → 200 (tests: ${OLD})`);
  return red(sb);
});
test('red green: superseded test updated', 0, (sb) => {
  roomsFails(sb); oldTest(sb);
  sb.edit(SPEC, '- Changes earlier behaviour: none', `- Changes earlier behaviour: 201 → 200 (tests: ${OLD})`);
  return red(sb, { changed: [OLD] });
});
test('red red: range in spec but no exhaustive test', 1, (sb) => {
  roomsFails(sb);
  sb.edit(SPEC, '- Ranges & invariants: none', '- Ranges & invariants: capacity 1..500 accepted, 0 and 501 → VALIDATION_FAILED');
  return red(sb);
});
test('red green: range covered by a parameterized test', 0, (sb) => {
  roomsFails(sb);
  sb.edit(SPEC, '- Ranges & invariants: none', '- Ranges & invariants: capacity 1..500 accepted, 0 and 501 → VALIDATION_FAILED');
  sb.edit('backend/src/test/java/com/oracul/app/rooms/RoomsApiIT.java', '@org.junit.jupiter.api.Test', '@org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(ints = {1, 500})');
  return red(sb);
});
const fe = (sb, out, opts = {}) => red(sb, { slice: '02_search', layers: { frontend: { code: 1, out } }, ...opts });
test('red green: frontend slice spec fails', 0, (sb) => fe(sb, ' FAIL  src/app/search/search.spec.ts > search > filters\nAssertionError: expected [] to have length 1'));
test('red red: frontend older spec broken by the new tests', 2, (sb) => {
  sb.put('frontend/src/app/rooms/rooms.spec.ts', "describe('rooms', () => {});\n");
  return fe(sb, ' FAIL  src/app/search/search.spec.ts > search\n FAIL  src/app/rooms/rooms.spec.ts > rooms > lists');
});
test('red red: frontend TestBed misses a provider', 2, (sb) => fe(sb, ' FAIL  src/app/search/search.spec.ts\nNullInjectorError: No provider for HttpClient!'));

// ---------------- gen-traceability
test('gen-traceability green: all FRs ✔', 0, (sb) => {
  sb.put('../../state/apps/fixture/last-run.json', JSON.stringify({ layers: { backend: { exit: 0 }, frontend: { exit: 0 } } }));
  return node(sb, 'checks/gen-traceability.mjs');
}, (sb) => {
  const t = sb.read('docs/phase-01_mvp/05_release/qa/traceability.md');
  return (/\| FR-1 \|.*\| ✔ \|/.test(t) && /\| FR-2 \|.*\| ✔ \|/.test(t) && t.includes('FR-1-room-created.png')) || t;
});
test('gen-traceability red: failing test → ✘ + exit 1', 1, (sb) => {
  sb.edit('backend/build/test-results/test/TEST-com.oracul.app.rooms.RoomsApiIT.xml', 'failures="0"', 'failures="1"');
  sb.put('../../state/apps/fixture/last-run.json', JSON.stringify({ layers: { backend: { exit: 1 }, frontend: { exit: 0 } } }));
  return node(sb, 'checks/gen-traceability.mjs');
}, (sb) => /\| FR-1 \|.*\| ✘ \|/.test(sb.read('docs/phase-01_mvp/05_release/qa/traceability.md')) || 'FR-1 not ✘');

// ---------------- state tool
test('state: init → phase new → approve → slices → next-slice → impact', 0, (sb) => {
  fs.rmSync(sb.stateDir, { recursive: true, force: true });
  const steps = [
    ['init', 'demo', '--title', 'Demo'], ['phase', 'new', 'mvp'], ['set', 'step', '03_plan'],
  ];
  for (const s of steps) { const r = node(sb, 'bin/state.mjs', s); if (r.code) return r; }
  const demo = path.join(sb.root, 'apps', 'demo', 'docs', 'phase-01_mvp');
  fs.cpSync(sb.doc('03_plan'), path.join(demo, '03_plan'), { recursive: true });
  fs.cpSync(sb.doc('01_scope'), path.join(demo, '01_scope'), { recursive: true });
  for (const s of [['approve', 'plan'], ['slices-from-plan']]) { const r = node(sb, 'bin/state.mjs', s); if (r.code) return r; }
  const n1 = node(sb, 'bin/state.mjs', ['next-slice']);
  node(sb, 'bin/state.mjs', ['slice', '01_rooms', 'BLOCKED']);
  const imp = node(sb, 'bin/state.mjs', ['impact', '01_rooms']);
  const n2 = node(sb, 'bin/state.mjs', ['next-slice', '--json']);
  const fr = node(sb, 'bin/state.mjs', ['next-fr']);
  const bad = node(sb, 'bin/state.mjs', ['set', 'step', 'nonsense']);
  const ok = n1.out.trim() === '01_rooms' && /"decision":"STOP"/.test(imp.out) && /"next":null/.test(n2.out)
    && /"skippedBecauseBlocked":\["02_search"\]/.test(n2.out) && /"nextFR":"FR-3"/.test(fr.out) && bad.code === 1;
  return { code: ok ? 0 : 1, out: [n1.out, imp.out, n2.out, fr.out, bad.out].join('\n') };
});

test('state green: set subStep test-fix', 0, (sb) => node(sb, 'bin/state.mjs', ['set', 'subStep', 'test-fix']),
  (sb) => JSON.parse(fs.readFileSync(path.join(sb.stateDir, 'apps/fixture/state.json'), 'utf8')).subStep === 'test-fix' || 'subStep not stored');
test('state green: set subStep e2e', 0, (sb) => node(sb, 'bin/state.mjs', ['set', 'subStep', 'e2e']),
  (sb) => JSON.parse(fs.readFileSync(path.join(sb.stateDir, 'apps/fixture/state.json'), 'utf8')).subStep === 'e2e' || 'subStep not stored');
test('state red: set unknown subStep', 1, (sb) => node(sb, 'bin/state.mjs', ['set', 'subStep', 'test-fixing']));

// ---------------- hooks: guard
const W = (file) => ({ tool_name: 'Write', tool_input: { file_path: file, content: 'x' } });
test('guard red: write into factory-engine', 2, (sb) => hook(sb, 'guard-edits', W(path.join(ENGINE, 'checks', 'verify.mjs'))));
test('guard red: bash redirect into factory-engine/state', 2, (sb) => hook(sb, 'guard-edits', { tool_name: 'Bash', tool_input: { command: `echo '{}' > ${path.join(ENGINE, 'state', 'x.json')}` } }));
test('guard green: bash copies a template out of the engine', 0, (sb) => hook(sb, 'guard-edits', { tool_name: 'Bash', tool_input: { command: `cp ${path.join(ENGINE, 'templates/docs/plan.md')} ${sb.doc('03_plan/plan2.md')}` } }));
test('guard green: bash runs engine scripts', 0, (sb) => hook(sb, 'guard-edits', { tool_name: 'Bash', tool_input: { command: `node ${path.join(ENGINE, 'checks/verify.mjs')} > /tmp/verify.log` } }));
test('guard red: edit generated client', 2, (sb) => hook(sb, 'guard-edits', W(sb.p('frontend/src/app/api/rooms.service.ts'))));
test('guard red: GREEN edits a test', 2, (sb) => { sb.state({ subStep: 'green' }); return hook(sb, 'guard-edits', W(sb.p('backend/src/test/java/com/oracul/app/rooms/RoomsApiIT.java'))); });
test('guard red: GREEN edits the contract', 2, (sb) => { sb.state({ subStep: 'green' }); return hook(sb, 'guard-edits', W(sb.p('api/openapi.yaml'))); });
test('guard green: GREEN edits production code', 0, (sb) => { sb.state({ subStep: 'green' }); return hook(sb, 'guard-edits', W(sb.p('backend/src/main/java/com/oracul/app/rooms/RoomService.java'))); });
test('guard red: RED edits production code', 2, (sb) => { sb.state({ subStep: 'red' }); return hook(sb, 'guard-edits', W(sb.p('frontend/src/app/rooms/rooms.ts'))); });
test('guard green: RED writes a test', 0, (sb) => { sb.state({ subStep: 'red' }); return hook(sb, 'guard-edits', W(sb.p('frontend/src/app/rooms/rooms.spec.ts'))); });
test('guard red: TEST-FIX edits production code', 2, (sb) => { sb.state({ subStep: 'test-fix' }); return hook(sb, 'guard-edits', W(sb.p('backend/src/main/java/com/oracul/app/rooms/RoomService.java'))); });
test('guard red: TEST-FIX edits the contract', 2, (sb) => { sb.state({ subStep: 'test-fix' }); return hook(sb, 'guard-edits', W(sb.p('api/openapi.yaml'))); });
test('guard green: TEST-FIX repairs a test', 0, (sb) => { sb.state({ subStep: 'test-fix' }); return hook(sb, 'guard-edits', W(sb.p('backend/src/test/java/com/oracul/app/rooms/RoomsApiIT.java'))); });
test('guard red: REVIEW edits code', 2, (sb) => { sb.state({ subStep: 'review' }); return hook(sb, 'guard-edits', W(sb.p('backend/src/main/java/X.java'))); });
test('guard green: REVIEW writes findings', 0, (sb) => { sb.state({ subStep: 'review' }); return hook(sb, 'guard-edits', W(sb.doc('04_build/01_rooms/review-findings.json'))); });

// ---------------- hooks: Playwright / Docker stack only in subStep e2e (+ tester scratch runs in test-fix)
const STACK = path.join(ENGINE, 'bin/stack.mjs');
const bash = (sb, sub, command) => { sb.state({ step: '04_build', slice: '01_rooms', subStep: sub }); return hook(sb, 'guard-edits', { tool_name: 'Bash', tool_input: { command } }); };
for (const [sub, cmd] of [
  ['green', 'npx playwright test'],
  ['green', 'cd apps/fixture/e2e && npx playwright test --grep x'],
  ['green', 'CI=true npx --yes playwright test rooms.spec.ts'],
  ['green', 'cd apps/fixture/e2e && npm test'],
  ['green', 'npm --prefix apps/fixture/e2e run test'],
  ['test-fix', `node ${STACK} e2e`],
  ['test-fix', `node ${STACK} e2e --scratch`],
  ['green', `node ${STACK} e2e --scratch --grep x`],
  ['red', `node "${STACK}" up`],
  ['review', 'docker compose up -d'],
  ['green', `node ${STACK} down`],
  ['green', 'docker stop fixture-backend-1'],
  ['green', `node ${path.join(ENGINE, 'bin/state.mjs')} set subStep green && npx playwright test`],
  ['e2e', `node ${path.join(ENGINE, 'bin/state.mjs')} set subStep review && node ${STACK} e2e`],
]) test(`guard red: ${sub} runs \`${cmd.replace(ENGINE, '<engine>')}\``, 2, (sb) => bash(sb, sub, cmd));
for (const [sub, cmd] of [
  ['test-fix', `node ${STACK} e2e --scratch --grep rooms.spec.ts`],
  ['e2e', `node ${STACK} e2e`],
  ['none', `node ${STACK} up && node ${STACK} down`],
  ['green', `node ${STACK} status`],
  ['green', 'cat apps/fixture/e2e/playwright.config.ts'],
  ['green', 'grep -r playwright apps/fixture/e2e'],
  ['green', 'docker compose logs backend'],
  ['green', 'docker ps'],
  ['green', 'cd apps/fixture/frontend && npm run test:ci'],
  ['green', 'cd apps/fixture/backend && ./gradlew test'],
  ['green', 'cd apps/fixture/e2e && npm install @playwright/test'],
  ['green', `node "${path.join(ENGINE, 'bin/state.mjs')}" set subStep e2e && node "${STACK}" e2e`],
]) test(`guard green: ${sub} runs \`${cmd.replace(ENGINE, '<engine>').replace(ENGINE, '<engine>')}\``, 0, (sb) => bash(sb, sub, cmd));

// ---------------- stack lock + scratch runs (no Docker: --dry-run stops before compose/Playwright)
const LOCK = (sb) => path.join(sb.stateDir, 'apps/fixture/stack.lock');
const putLock = (sb, pid, startedAt = new Date().toISOString()) => write(LOCK(sb), JSON.stringify({ pid, cmd: 'e2e', startedAt }));
const deadPid = () => spawnSync('node', ['-e', '']).pid;
const TEMPLATE_PW = fs.readFileSync(path.join(ENGINE, 'templates/app/e2e/playwright.config.ts'), 'utf8');
test('stack red: live lock → STACK BUSY exit 3', 3, (sb) => { putLock(sb, process.pid); return node(sb, 'bin/stack.mjs', ['up', '--lock-wait', '0', '--dry-run']); },
  (sb, r) => (/STACK BUSY: e2e by pid/.test(r.out) && fs.existsSync(LOCK(sb))) || 'busy message missing or live lock deleted');
test('stack green: stale lock taken over, released after', 0, (sb) => { putLock(sb, deadPid()); return node(sb, 'bin/stack.mjs', ['e2e', '--dry-run']); },
  (sb, r) => (/stale stack lock/.test(r.out) && /DRY RUN/.test(r.out) && !fs.existsSync(LOCK(sb))) || r.out);
test('stack red: scratch run without --grep', 1, (sb) => { sb.put('e2e/playwright.config.ts', TEMPLATE_PW); return node(sb, 'bin/stack.mjs', ['e2e', '--scratch', '--dry-run']); });
test('stack red: scratch run on a config without E2E_REPORT_DIR/E2E_OUTPUT_DIR', 1, (sb) => node(sb, 'bin/stack.mjs', ['e2e', '--scratch', '--grep', 'rooms.spec.ts', '--dry-run']),
  (sb, r) => (/E2E_REPORT_DIR\/E2E_OUTPUT_DIR support/.test(r.out) && !/DRY RUN/.test(r.out) && !fs.existsSync(LOCK(sb))) || r.out);
test('stack green: scratch run on the template config', 0, (sb) => { sb.put('e2e/playwright.config.ts', TEMPLATE_PW); return node(sb, 'bin/stack.mjs', ['e2e', '--scratch', '--grep', 'rooms.spec.ts', '--dry-run']); },
  (sb, r) => (/playwright test rooms\.spec\.ts/.test(r.out) && /E2E_REPORT_DIR=report-scratch/.test(r.out) && /E2E_OUTPUT_DIR=test-results-scratch/.test(r.out)) || r.out);
test('scratch env green: never points at official output', 0, (sb) => {
  const p = scratchEnvProblems(e2eEnv({ appDir: sb.appDir, phaseDir: sb.doc(''), scratch: true }), sb.appDir);
  return { code: p.length ? 1 : 0, out: p.join('\n') };
});
test('scratch env red: env writing e2e/report is rejected', 1, (sb) => {
  const p = scratchEnvProblems({ ...e2eEnv({ appDir: sb.appDir, phaseDir: sb.doc(''), scratch: true }), E2E_REPORT_DIR: 'report' }, sb.appDir);
  return { code: p.length ? 1 : 0, out: p.join('\n') };
});
test('scratch env red: official env used as scratch is rejected', 1, (sb) => {
  const p = scratchEnvProblems(e2eEnv({ appDir: sb.appDir, phaseDir: sb.doc(''), scratch: false }), sb.appDir);
  return { code: p.length ? 1 : 0, out: p.join('\n') };
});
test('template green: playwright config supports scratch, defaults unchanged', 0, () => {
  const ok = scratchSupported(TEMPLATE_PW) && /E2E_REPORT_DIR \?\? 'report'/.test(TEMPLATE_PW) && /E2E_OUTPUT_DIR \?\? 'test-results'/.test(TEMPLATE_PW)
    && /\$\{reportDir\}\/results\.json/.test(TEMPLATE_PW);
  return { code: ok ? 0 : 1, out: TEMPLATE_PW };
});
test('template red: config without env support is rejected', 1, (sb) => ({ code: scratchSupported(sb.read('e2e/playwright.config.ts')) ? 0 : 1, out: '' }));
const FAILED_REPORT = { suites: [{ title: 'rooms.spec.ts', file: 'rooms.spec.ts', specs: [{ title: 'FR-1 create room', file: 'rooms.spec.ts', tests: [{ status: 'unexpected', projectName: 'chromium',
  results: [{ status: 'failed', error: { message: '\u001b[31mError: expect(locator).toBeVisible() failed\u001b[39m\nLocator: getByTestId(\'room-row\')' },
    attachments: [{ name: 'trace', contentType: 'application/zip', path: '/app/e2e/test-results/rooms-FR-1/trace.zip' }] }] }] }], suites: [] }] };
test('failure block green: names file, title, error and trace', 0, () => {
  const b = failureBlock(FAILED_REPORT, '/app');
  const ok = /==== E2E FAILURES \(1\)/.test(b) && /rooms\.spec\.ts › FR-1 create room/.test(b) && /toBeVisible\(\) failed/.test(b) && !/\u001b/.test(b)
    && /attachment: e2e\/test-results\/rooms-FR-1\/trace\.zip/.test(b) && /END E2E FAILURES/.test(b);
  return { code: ok ? 0 : 1, out: b };
});
test('failure block red: passing report has no block', 1, (sb) => {
  const b = failureBlock(JSON.parse(sb.read('e2e/report/results.json')), sb.appDir);
  return { code: b ? 0 : 1, out: b };
});
test('failure block green: 12 failures fit the 80-line runner window', 0, () => {
  const many = { suites: [{ file: 'a.spec.ts', specs: Array.from({ length: 12 }, (_, i) => ({ title: `t${i}`, file: 'a.spec.ts', tests: [{ status: 'unexpected', results: [{ error: { message: Array.from({ length: 30 }, (_, j) => `line ${j}`).join('\n') } }] }] })) }] };
  const lines = failureBlock(many, '/app').split('\n');
  return { code: lines.length <= 70 && lines.some((l) => /2 more failure/.test(l)) ? 0 : 1, out: `${lines.length} lines` };
});

// lock library (async)
const asyncTests = [];
const atest = (name, expectCode, fn) => { if (!filter || name.includes(filter)) asyncTests.push({ name, expectCode, fn }); };
const lockFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oracul-lock-')), 'stack.lock');
const quiet = () => {};
atest('lock red: live fresh lock, no wait → busy', 3, async () => {
  const f = lockFile(); write(f, JSON.stringify({ pid: process.pid, cmd: 'e2e', startedAt: new Date().toISOString() }));
  const l = await acquire(f, 'up', { waitS: 0, log: quiet });
  return { code: l.ok ? 0 : 3, out: fs.existsSync(f) ? '' : 'live lock was deleted' };
});
atest('lock green: dead pid → taken over', 0, async () => {
  const f = lockFile(); write(f, JSON.stringify({ pid: deadPid(), cmd: 'e2e', startedAt: new Date().toISOString() }));
  const l = await acquire(f, 'up', { waitS: 0, log: quiet });
  const mine = JSON.parse(fs.readFileSync(f, 'utf8')).pid === process.pid;
  l.release?.();
  return { code: l.ok && mine && !fs.existsSync(f) ? 0 : 1, out: '' };
});
atest('lock green: live pid but 2 h old → taken over', 0, async () => {
  const f = lockFile(); write(f, JSON.stringify({ pid: process.pid, cmd: 'e2e', startedAt: new Date(Date.now() - 2 * 3600_000).toISOString() }));
  const l = await acquire(f, 'up', { waitS: 0, log: quiet });
  l.release?.();
  return { code: l.ok && !fs.existsSync(f) ? 0 : 1, out: '' };
});
atest('lock green: no lock → acquired, gone after release', 0, async () => {
  const f = lockFile();
  const l = await acquire(f, 'up', { waitS: 0, log: quiet });
  const held = fs.existsSync(f) && JSON.parse(fs.readFileSync(f, 'utf8')).cmd === 'up';
  l.release();
  return { code: l.ok && held && !fs.existsSync(f) ? 0 : 1, out: '' };
});
atest('lock red: lock released by its holder is free again; a second holder waits', 3, async () => {
  const f = lockFile();
  const a = await acquire(f, 'e2e', { waitS: 0, log: quiet });
  const b = await acquire(f, 'up', { waitS: 0, log: quiet });
  a.release();
  return { code: a.ok && !b.ok ? 3 : 0, out: '' };
});

// ---------------- hooks: stop / subagent-stop / session-start
test('stop red: build step with RED verify blocks once', 2, (sb) => { sb.state({ step: '04_build', lastVerify: { at: new Date().toISOString(), result: 'RED', failing: ['check-coverage'] } }); return hook(sb, 'stop', { stop_hook_active: false }); });
test('stop green: second attempt is allowed', 0, (sb) => { sb.state({ step: '04_build', lastVerify: { at: new Date().toISOString(), result: 'RED', failing: ['x'] } }); return hook(sb, 'stop', { stop_hook_active: true }); });
test('stop green: dialog step never blocks', 0, (sb) => { sb.state({ step: '01_scope', lastVerify: null }); return hook(sb, 'stop', { stop_hook_active: false }); });
test('stop red: code changed after GREEN verify', 2, (sb) => {
  sb.state({ step: '04_build', lastVerify: { at: new Date(Date.now() - 3_600_000).toISOString(), result: 'GREEN', failing: [] } });
  sb.put('backend/src/main/java/com/oracul/app/New.java', 'class New {}');
  return hook(sb, 'stop', { stop_hook_active: false });
});
test('stop red: change 0.5 s after GREEN verify still counts', 2, (sb) => {
  sb.state({ step: '04_build', lastVerify: { at: new Date(Date.now() - 500).toISOString(), result: 'GREEN', failing: [] } });
  sb.put('e2e/tests/new.spec.ts', '// new');
  return hook(sb, 'stop', { stop_hook_active: false });
});
test('stop green: build step with fresh GREEN verify', 0, (sb) => { sb.state({ step: '04_build' }); return hook(sb, 'stop', { stop_hook_active: false }); });
test('subagent-stop red: reviewer finished without findings file', 2, (sb) => {
  sb.state({ step: '04_build', subStep: 'review', slice: '01_rooms' });
  sb.rm('docs/phase-01_mvp/04_build/01_rooms/review-findings.json');
  return hook(sb, 'subagent-stop', { agent_type: 'oracul:reviewer', stop_hook_active: false });
});
test('subagent-stop green: unrelated agent type', 0, (sb) => {
  sb.state({ step: '04_build', subStep: 'review', slice: '01_rooms' });
  sb.rm('docs/phase-01_mvp/04_build/01_rooms/review-findings.json');
  return hook(sb, 'subagent-stop', { agent_type: 'Explore' });
});
test('subagent-stop red: tester left an FR untagged', 2, (sb) => {
  sb.state({ step: '04_build', subStep: 'red', slice: '02_search' });
  sb.rm('frontend/src/app/search/search.spec.ts');
  return hook(sb, 'subagent-stop', { agent_type: 'oracul:tester' });
});
test('subagent-stop red: tester test-fix dropped an FR tag', 2, (sb) => {
  sb.state({ step: '04_build', subStep: 'test-fix', slice: '02_search' });
  sb.rm('frontend/src/app/search/search.spec.ts');
  return hook(sb, 'subagent-stop', { agent_type: 'oracul:tester' });
});
test('subagent-stop green: tester test-fix kept the tags', 0, (sb) => {
  sb.state({ step: '04_build', subStep: 'test-fix', slice: '02_search' });
  return hook(sb, 'subagent-stop', { agent_type: 'oracul:tester' });
});
test('subagent-stop red: release test-fix dropped an FR tag', 2, (sb) => {
  sb.state({ subStep: 'test-fix' });
  sb.rm('frontend/src/app/search/search.spec.ts');
  return hook(sb, 'subagent-stop', { agent_type: 'oracul:tester' });
});
test('subagent-stop red: analyst spec delta without ranges line', 2, (sb) => {
  sb.state({ step: '04_build', subStep: 'spec', slice: '01_rooms' });
  sb.edit(SPEC, '- Ranges & invariants: none\n', '');
  return hook(sb, 'subagent-stop', { agent_type: 'oracul:analyst' });
});
test('subagent-stop green: analyst spec delta complete', 0, (sb) => {
  sb.state({ step: '04_build', subStep: 'spec', slice: '01_rooms' });
  return hook(sb, 'subagent-stop', { agent_type: 'oracul:analyst' });
});
test('subagent-stop green: analyst plan done (approval pending is fine)', 0, (sb) => {
  sb.state({ step: '03_plan' });
  sb.edit('docs/phase-01_mvp/03_plan/plan.md', /^Status:.*$/m, 'Status: DRAFT');
  return hook(sb, 'subagent-stop', { agent_type: 'oracul:analyst' });
});
test('session-start: briefs active app', 0, (sb) => hook(sb, 'session-start', {}), (sb, r) => (/Active app: fixture/.test(r.out) && /step 05_release/.test(r.out)) || r.out);

// ---------------- engine integrity: plugin, agents, skills, hooks, workflows
test('integrity: plugin, agents, skills, hooks, workflows parse', 0, () => {
  const problems = [];
  const pj = JSON.parse(fs.readFileSync(path.join(ENGINE, '.claude-plugin/plugin.json'), 'utf8'));
  if (pj.name !== 'oracul') problems.push('plugin name');
  const fm = (f) => (fs.readFileSync(f, 'utf8').match(/^---\n([\s\S]*?)\n---/) || [])[1] || '';
  for (const a of fs.readdirSync(path.join(ENGINE, 'agents'))) {
    const m = fm(path.join(ENGINE, 'agents', a));
    if (!/^name: \S+/m.test(m) || !/^description: .+/m.test(m)) problems.push(`agent ${a} frontmatter`);
  }
  for (const s of fs.readdirSync(path.join(ENGINE, 'skills'))) {
    const m = fm(path.join(ENGINE, 'skills', s, 'SKILL.md'));
    if (!new RegExp(`^name: ${s}$`, 'm').test(m) || !/^description: .+/m.test(m)) problems.push(`skill ${s} frontmatter`);
  }
  const hj = JSON.parse(fs.readFileSync(path.join(ENGINE, 'hooks/hooks.json'), 'utf8'));
  for (const groups of Object.values(hj.hooks)) for (const g of groups) for (const h of g.hooks) {
    const script = h.command.match(/hooks\/([\w-]+\.mjs)/)[1];
    if (!fs.existsSync(path.join(ENGINE, 'hooks', script))) problems.push(`hook script ${script}`);
  }
  for (const w of fs.readdirSync(path.join(ENGINE, 'workflows'))) {
    const src = fs.readFileSync(path.join(ENGINE, 'workflows', w), 'utf8');
    if (!/^export const meta = \{/.test(src)) problems.push(`${w}: meta must come first`);
    if (/Date\.now\(\)|Math\.random\(\)|new Date\(\)/.test(src)) problems.push(`${w}: non-deterministic call`);
    try {
      const AsyncFn = Object.getPrototypeOf(async () => {}).constructor;
      new AsyncFn('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget', 'workflow', src.replace(/^export const meta/m, 'const meta'));
    } catch (e) { problems.push(`${w}: ${e.message}`); }
  }
  return { code: problems.length ? 1 : 0, out: problems.join('\n') };
});

// ---------------- workflows: build-slice stage contract (stub agents, no real commands)
async function runWorkflow(file, args, answer, source) {
  const src = (source ?? fs.readFileSync(path.join(ENGINE, 'workflows', file), 'utf8')).replace(/^export const meta/m, 'const meta');
  const AsyncFn = Object.getPrototypeOf(async () => {}).constructor;
  const calls = [];
  const agent = async (prompt, opts = {}) => { calls.push({ prompt, opts }); return answer(prompt, opts); };
  const parallel = async (ts) => Promise.all(ts.map((t) => t().catch(() => null)));
  const fn = new AsyncFn('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget', 'workflow', src);
  return { result: await fn(agent, parallel, null, () => {}, () => {}, args, null, null), calls };
}
const wfArgs = (extra) => ({ engine: ENGINE, root: '/r', app: 'a', appDir: '/r/apps/a', phase: 'phase-01_mvp', phaseDir: '/r/apps/a/docs/phase-01_mvp', slice: '01_rooms', frs: ['FR-1'], ...extra });
const ok0 = (p, o) => (o.schema && o.schema.required?.includes('exitCode') ? { exitCode: 0, output: '{"slice":"01_rooms","decision":"CONTINUE","dependents":[]}' } : o.schema ? { summary: '', testProblems: [], open: [], code: '', tests: [] } : 'done');
const asyncCases = [];
const wf = (name, expectCode, args, answer, judge) => { if (!filter || name.includes(filter)) asyncCases.push({ name, expectCode, args, answer, judge }); };
wf('workflow red: build-slice without stage', 1, wfArgs({}), ok0, ({ result }) => (result.error ? 1 : 0));
wf('workflow red: build-slice green without red-check result', 1, wfArgs({ stage: 'green' }), ok0, ({ result }) => (result.error ? 1 : 0));
wf('workflow green: stage red never runs red-check itself', 0, wfArgs({ stage: 'red' }), ok0,
  ({ result, calls }) => (result.stage === 'red' && /red-check\.mjs" --slice 01_rooms/.test(result.next)
    && !calls.some((c) => c.opts.label?.startsWith('run:') && /red-check/.test(c.prompt)) ? 0 : 1));
wf('workflow green: stage red asks the tester for a red-check self-check and the analyst for both spec lines', 0, wfArgs({ stage: 'red' }), ok0, ({ calls }) => {
  const tester = calls.find((c) => c.opts.label?.startsWith('tester: red'));
  const analyst = calls.find((c) => c.opts.label?.startsWith('analyst: spec'));
  return tester && /red-check\.mjs" --slice 01_rooms/.test(tester.prompt) && /Ranges & invariants/.test(tester.prompt)
    && analyst && /Changes earlier behaviour/.test(analyst.prompt) && /Ranges & invariants/.test(analyst.prompt) && /--stage spec/.test(analyst.prompt) ? 0 : 1;
});
wf('workflow red: tester red prompt without self-check would be caught', 1, wfArgs({ stage: 'red' }), ok0, ({ calls }) => {
  const tester = calls.find((c) => c.opts.label?.startsWith('tester: red'));
  const stripped = tester.prompt.replace(/red-check/g, 'xxx');
  return /red-check\.mjs" --slice 01_rooms/.test(stripped) ? 0 : 1;
});
wf('workflow red: failed red-check → BLOCKED', 1, wfArgs({ stage: 'green', red: { exitCode: 2, output: 'COMPILE-ERROR' } }), ok0,
  ({ result }) => (result.status === 'BLOCKED' && result.failing.includes('red-check') ? 1 : 0));
wf('workflow green: verify → e2e → review → DONE', 0, wfArgs({ stage: 'green', red: { exitCode: 0, output: '' } }), ok0, ({ result, calls }) => {
  const order = calls.map((c) => c.prompt).map((p) => (/verify\.mjs/.test(p) ? 'verify' : /stack\.mjs" e2e/.test(p) ? 'e2e' : /check-review/.test(p) ? 'review' : null)).filter(Boolean);
  return result.status === 'DONE' && order.join(',') === 'verify,e2e,review' ? 0 : 1;
});
wf('workflow green: test finding goes to tester, code finding to builders', 0, wfArgs({ stage: 'green', red: { exitCode: 0, output: '' } }), (() => {
  let reviews = 0;
  return (p, o) => {
    if (/check-review/.test(p)) return { exitCode: reviews > 1 ? 0 : 1, output: 'INVALID open' };
    if (o.label?.startsWith('reviewer')) { reviews++; return { open: [{ id: 'R1', severity: 'high', dimension: 'tests', file: 'e2e/tests/rooms.spec.ts', problem: 'wrong testid' }, { id: 'R2', severity: 'high', dimension: 'correctness', file: 'backend/src/main/java/X.java', problem: 'npe' }] }; }
    return ok0(p, o);
  };
})(), ({ result, calls }) => {
  const r2 = calls.filter((c) => / r2$/.test(c.opts.label || ''));
  const tester = r2.find((c) => c.opts.label === 'tester: fix 01_rooms r2');
  const be = r2.find((c) => c.opts.label === 'backend: 01_rooms r2');
  const testFix = calls.findIndex((c) => /set subStep test-fix/.test(c.prompt));
  return result.status === 'DONE' && tester && /rooms\.spec\.ts/.test(tester.prompt) && !/rooms\.spec\.ts/.test(be.prompt) && /npe/.test(be.prompt) && !/npe/.test(tester.prompt) && testFix >= 0 ? 0 : 1;
});
const e2eCalls = (calls) => calls.filter((c) => /stack\.mjs" e2e/.test(c.prompt));
wf('workflow green: every official e2e run sets subStep e2e right before it', 0, wfArgs({ stage: 'green', red: { exitCode: 0, output: '' } }), ok0, ({ calls }) => {
  const runs = e2eCalls(calls);
  return runs.length && runs.every((c) => { const i = c.prompt.indexOf('set subStep e2e'); return i >= 0 && i < c.prompt.indexOf('stack.mjs" e2e'); }) ? 0 : 1;
});
const busyThen = (busyTimes) => { let n = 0; return (p, o) => (/stack\.mjs" e2e/.test(p) ? (n++ < busyTimes ? { exitCode: 3, output: 'STACK BUSY: e2e by pid 42 since x' } : { exitCode: 0, output: 'E2E PASS' }) : ok0(p, o)); };
const between = (calls, from, to) => calls.slice(from + 1, to);
wf('workflow green: stack busy once → rerun, no fix round, DONE', 0, wfArgs({ stage: 'green', red: { exitCode: 0, output: '' } }), busyThen(1), ({ result, calls }) => {
  const idx = calls.map((c, i) => (/stack\.mjs" e2e/.test(c.prompt) ? i : -1)).filter((i) => i >= 0);
  const mid = between(calls, idx[0], idx[1]);
  return result.status === 'DONE' && idx.length === 2 && !mid.some((c) => /^(triage|tester|backend|frontend)/.test(c.opts.label || '')) ? 0 : 1;
});
wf('workflow red: stack busy twice → BLOCKED "e2e: stack busy", never triaged', 1, wfArgs({ stage: 'green', red: { exitCode: 0, output: '' } }), busyThen(2), ({ result, calls }) =>
  (result.status === 'BLOCKED' && result.failing.includes('e2e: stack busy') && !calls.some((c) => /^triage/.test(c.opts.label || '')) ? 1 : 0));
const GUARD_OUT = 'PreToolUse:Bash hook error: [node "/e/hooks/guard-edits.mjs"]: [oracul guard] `node "/e/bin/stack.mjs" e2e` is a stack operation: …'
const refuse = (re) => (p, o) => (re.test(p) ? { exitCode: 1, output: GUARD_OUT } : ok0(p, o));
const oneRoundNoTriage = (calls) => !calls.some((c) => /^triage/.test(c.opts.label || '')) && !calls.some((c) => / r2$/.test(c.opts.label || ''));
wf('workflow red: E2E refused by the guard → BLOCKED "e2e: blocked by guard hook", never triaged, one round', 1, wfArgs({ stage: 'green', red: { exitCode: 0, output: '' } }), refuse(/stack\.mjs" e2e/), ({ result, calls }) =>
  (result.status === 'BLOCKED' && result.failing.includes('e2e: blocked by guard hook') && oneRoundNoTriage(calls) ? 1 : 0));
wf('workflow red: verify refused by the guard → BLOCKED "verify: blocked by guard hook", never triaged, one round', 1, wfArgs({ stage: 'green', red: { exitCode: 0, output: '' } }), refuse(/checks\/verify\.mjs"/), ({ result, calls }) =>
  (result.status === 'BLOCKED' && result.failing.includes('verify: blocked by guard hook') && oneRoundNoTriage(calls) ? 1 : 0));
wf('workflow green: a real E2E failure is still triaged (not mistaken for a guard block)', 0, wfArgs({ stage: 'green', red: { exitCode: 0, output: '' } }), (() => {
  let n = 0;
  return (p, o) => (/stack\.mjs" e2e/.test(p) && !n++ ? { exitCode: 1, output: 'E2E FAIL\n  1 failed: rooms.spec.ts' } : ok0(p, o));
})(), ({ result, calls }) => (result.status === 'DONE' && calls.some((c) => /^triage: E2E/.test(c.opts.label || '')) ? 0 : 1));
const BLOCK = '==== E2E FAILURES (1) ====\n✘ rooms.spec.ts › FR-1 create room\n    Error: not visible\n==== END E2E FAILURES ===='
wf('workflow green: E2E FAILURES block reaches the next fix round; builders told not to run E2E', 0, wfArgs({ stage: 'green', red: { exitCode: 0, output: '' } }), (() => {
  let n = 0;
  return (p, o) => (/stack\.mjs" e2e/.test(p) ? (n++ ? { exitCode: 0, output: 'E2E PASS' } : { exitCode: 1, output: `E2E FAIL\n${BLOCK}` }) : ok0(p, o));
})(), ({ result, calls }) => {
  const be2 = calls.find((c) => c.opts.label === 'backend: 01_rooms r2');
  const be1 = calls.find((c) => c.opts.label === 'backend: 01_rooms r1');
  const tri = calls.findIndex((c) => /^triage: E2E/.test(c.opts.label || ''));
  const greenBeforeTriage = /set subStep green/.test(calls[tri - 1]?.prompt || '');
  return result.status === 'DONE' && be2 && be2.prompt.includes(BLOCK) && !be1.prompt.includes('E2E FAILURES ====')
    && /Do not run Playwright/.test(be1.prompt) && greenBeforeTriage ? 0 : 1;
});
for (const c of asyncCases) {
  let got, note = '';
  try { got = c.judge(await runWorkflow('build-slice.js', c.args, c.answer)); } catch (e) { got = 'ERR'; note = String(e); }
  results.push({ name: c.name, ok: got === c.expectCode, expectCode: c.expectCode, got, note, out: '' });
}

// note() runs for real in bash: an exact repeat (runner executed the command twice) is appended once;
// a different block under the same title (a resumed run) is still appended.
const noteCommands = async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracul-note-'));
  const cmds = [];
  let v = 0;
  await runWorkflow('build-slice.js', wfArgs({ stage: 'green', red: { exitCode: 0, output: '' }, phaseDir: dir, maxRounds: 2 }), (p, o) => {
    if (o.label?.startsWith('run: note')) cmds.push((p.match(/```bash\n([\s\S]*?)\n```/) || [])[1]);
    return /checks\/verify\.mjs"/.test(p) ? { exitCode: 1, output: `verify RED #${++v}` } : ok0(p, o);
  });
  return { dir, cmds: cmds.filter(Boolean) };
};
for (const [name, expectCode, plan] of [
  ['note green: runner executes the same note twice → appended once', 0, (c) => [c[0], c[0]]],
  ['note red: two different notes are both appended (resume is not swallowed)', 1, (c) => [c[0], c[1]]],
]) {
  if (filter && !name.includes(filter)) continue;
  let got, note = '';
  try {
    const { dir, cmds } = await noteCommands();
    for (const cmd of plan(cmds)) { const r = spawnSync('bash', ['-c', cmd], { encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); }
    const text = fs.readFileSync(path.join(dir, '04_build', '01_rooms', 'rounds.md'), 'utf8');
    const heads = (text.match(/^## Round \d+$/gm) || []).length;
    got = heads === 1 ? 0 : heads === 2 ? 1 : 'other';
    note = `${heads} heading(s)`;
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) { got = 'ERR'; note = String(e); }
  results.push({ name, ok: got === expectCode, expectCode, got, note, out: '' });
}

const relArgs = { engine: ENGINE, root: '/r', app: 'a', appDir: '/r/apps/a', phase: 'phase-01_mvp', phaseDir: '/r/apps/a/docs/phase-01_mvp' };
for (const [name, expectCode, answer, problem] of [
  ['workflow red: release E2E refused by the guard → RED "e2e: blocked by guard hook", never triaged', 1, () => refuse(/stack\.mjs" e2e/), 'e2e: blocked by guard hook'],
  ['workflow red: release verify refused by the guard → RED "verify: blocked by guard hook", never triaged', 1, () => refuse(/checks\/verify\.mjs" --scope all/), 'verify: blocked by guard hook'],
]) {
  if (filter && !name.includes(filter)) continue;
  let got, note = '';
  try {
    const { result, calls } = await runWorkflow('finish-and-run.js', relArgs, answer());
    const triaged = calls.some((c) => /^triage/.test(c.opts.label || ''));
    got = result.status === 'RED' && result.problems.includes(problem) && !triaged ? 1 : 0;
    if (!got) note = JSON.stringify(result).slice(0, 300);
  } catch (e) { got = 'ERR'; note = String(e); }
  results.push({ name, ok: got === expectCode, expectCode, got, note, out: '' });
}
for (const [name, expectCode, busyTimes] of [['workflow red: release stack busy twice → RED "e2e: stack busy", never triaged', 1, 2], ['workflow green: release stack busy once → rerun, GREEN', 0, 1]]) {
  if (filter && !name.includes(filter)) continue;
  let got, note = '';
  try {
    const { result, calls } = await runWorkflow('finish-and-run.js', relArgs, busyThen(busyTimes));
    const triaged = calls.some((c) => /^triage/.test(c.opts.label || ''));
    got = result.status === 'RED' && result.problems.includes('e2e: stack busy') && !triaged ? 1 : result.status === 'GREEN' && !triaged ? 0 : 'other';
    if (got === 'other') note = JSON.stringify(result).slice(0, 300);
  } catch (e) { got = 'ERR'; note = String(e); }
  results.push({ name, ok: got === expectCode, expectCode, got, note, out: '' });
}
for (const t of asyncTests) {
  let res, note = '';
  try { res = await t.fn(); } catch (e) { res = { code: 'ERR', out: '' }; note = String(e); }
  results.push({ name: t.name, ok: res.code === t.expectCode, expectCode: t.expectCode, got: res.code, note: note || res.out, out: res.out });
}

// Replay: every command a workflow runs must pass the real guard hook in the subStep the workflow itself set before it
// (the hook runs BEFORE a command, so a chained `set subStep x && …` is judged segment by segment).
async function replayThroughHook(file, args, answer, source) {
  const sb = sandbox();
  sb.state({ step: file === 'build-slice.js' ? '04_build' : '05_release', slice: '01_rooms', subStep: 'green' });
  const blocked = [];
  const { result } = await runWorkflow(file, { ...args, engine: ENGINE, root: sb.root, appDir: sb.appDir, phaseDir: sb.doc('') }, (p, o) => {
    if (o.label?.startsWith('run:')) {
      const cmd = (p.match(/```bash\n([\s\S]*?)\n```/) || [])[1] || '';
      const h = hook(sb, 'guard-edits', { tool_name: 'Bash', tool_input: { command: cmd } });
      if (h.code !== 0) blocked.push(`${o.label}: ${h.out.trim().slice(0, 160)}`);
      for (const m of cmd.matchAll(/set subStep (\S+)/g)) sb.state({ subStep: m[1] });
    }
    return answer(p, o);
  }, source);
  fs.rmSync(sb.root, { recursive: true, force: true });
  return { result, blocked };
}
const e2eFailsOnce = () => { let n = 0; return (p, o) => (/stack\.mjs" e2e/.test(p) && !n++ ? { exitCode: 1, output: `E2E FAIL\n${BLOCK}` } : ok0(p, o)); };
for (const [name, file, args] of [
  ['replay green: build-slice green stage — every command passes the guard', 'build-slice.js', wfArgs({ stage: 'green', red: { exitCode: 0, output: '' } })],
  ['replay green: build-slice red stage — every command passes the guard', 'build-slice.js', wfArgs({ stage: 'red' })],
  ['replay green: finish-and-run — every command passes the guard', 'finish-and-run.js', relArgs],
]) {
  if (filter && !name.includes(filter)) continue;
  let got, note = '';
  try { const r = await replayThroughHook(file, args, e2eFailsOnce()); got = r.blocked.length ? 1 : 0; note = r.blocked.join(' | '); } catch (e) { got = 'ERR'; note = String(e); }
  results.push({ name, ok: got === 0, expectCode: 0, got, note, out: '' });
}
{ // red counterpart: a workflow that runs E2E without switching to subStep e2e is caught by the replay
  const name = 'replay red: E2E run while still in subStep green is caught';
  if (!filter || name.includes(filter)) {
    let got, note = '';
    try {
      const src = fs.readFileSync(path.join(ENGINE, 'workflows', 'build-slice.js'), 'utf8');
      const mutated = src.replace("`${node('bin/state.mjs', 'set subStep e2e')} && ${node('bin/stack.mjs', 'e2e')}`", "node('bin/stack.mjs', 'e2e')");
      if (mutated === src) throw new Error('mutation did not apply — update this case');
      const r = await replayThroughHook('build-slice.js', wfArgs({ stage: 'green', red: { exitCode: 0, output: '' } }), ok0, mutated);
      got = r.blocked.length ? 1 : 0; note = r.blocked[0] || 'nothing blocked';
    } catch (e) { got = 'ERR'; note = String(e); }
    results.push({ name, ok: got === 1, expectCode: 1, got, note, out: '' });
  }
}

// ---------------- report
const pad = Math.max(...results.map((r) => r.name.length));
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(pad)}  expected exit ${r.expectCode}, got ${r.got}${r.note ? `  — ${String(r.note).slice(0, 200)}` : ''}`);
  if (!r.ok) console.log(r.out.split('\n').map((l) => `      | ${l}`).join('\n'));
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} self-test cases passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
