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
import { analyseRed, recordFlaky, renderEvidence } from '../checks/lib/red.mjs';
import { gradleFilterValid, isolationVerdicts, layerCommand, relatedTests } from '../checks/lib/related.mjs';
import { diagnostics, summaryLine } from '../checks/lib/compile.mjs';
import { acquire } from '../checks/lib/lock.mjs';
import { e2eEnv, e2eFocus, failureBlock, scratchEnvProblems, scratchSupported } from '../checks/lib/e2e.mjs';
import { slowestClasses, springContexts, summariseTimings } from '../checks/lib/timing.mjs';
import { dockerignoreMatcher, imageInputsHash } from '../checks/lib/hash.mjs';
import { composeArgs } from '../checks/lib/stack.mjs';
import { filesByGroup, gateHash, groupOf } from '../checks/lib/inputs.mjs';
// write ledger entries for the sandbox app as if the gates ran on the current inputs
function recordGatesFor(sb, gates) {
  const l = { gates: Object.fromEntries(gates.map((g) => [g, { hash: gateHash(sb.appDir, g), result: 'pass', full: true, at: new Date().toISOString() }])) };
  write(path.join(sb.stateDir, 'apps/fixture/gates.json'), JSON.stringify(l));
}

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

// WP-P: required + nullable is rejected where NON_NULL would drop the field; generator + null-convention defaults
const SCHEMAS = (req, prop) => `components:\n  schemas:\n    Provider:\n      type: object\n      ${req}\n      properties:\n        name:\n          type: string\n        providerCode:\n${prop}\n`;
const NULLABLE = '          type: string\n          nullable: true';
const nonNullApp = (sb) => sb.put('backend/src/main/resources/application.properties', 'spring.jackson.default-property-inclusion=non_null\n');
const withSchemas = (sb, req, prop) => sb.put('api/openapi.yaml', sb.read('api/openapi.yaml') + SCHEMAS(req, prop));
test('contract red: required + nullable in an app with the null convention', 1, (sb) => { nonNullApp(sb); withSchemas(sb, 'required: [name, providerCode]', NULLABLE); return node(sb, 'checks/check-contract.mjs'); },
  (sb, r) => /required \+ nullable: Provider\.providerCode/.test(r.out) || r.out);
test('contract red: required (block list) + OpenAPI 3.1 type null', 1, (sb) => { nonNullApp(sb); withSchemas(sb, 'required:\n        - providerCode', "          type: [string, 'null']"); return node(sb, 'checks/check-contract.mjs'); });
test('contract green: optional nullable is fine', 0, (sb) => { nonNullApp(sb); withSchemas(sb, 'required: [name]', NULLABLE); return node(sb, 'checks/check-contract.mjs'); });
test('contract green: an app that writes nulls only gets a WARN', 0, (sb) => { withSchemas(sb, 'required: [name, providerCode]', NULLABLE); return node(sb, 'checks/check-contract.mjs'); },
  (sb, r) => /WARN\s+required \+ nullable/.test(r.out) || r.out);
const TPL_GRADLE = fs.readFileSync(path.join(ENGINE, 'templates/app/backend/build.gradle.kts'), 'utf8');
const genDefaults = (t) => /"skipDefaultInterface" to "false"/.test(t) && /"generatedConstructorWithRequiredArgs" to "false"/.test(t);
test('template green: new operations compile as 501 defaults; required fields do not change constructors', 0, () => ({ code: genDefaults(TPL_GRADLE) ? 0 : 1, out: '' }));
test('template green: template code builds generated models fluently (no required-args constructors exist)', 0, () => {
  const bad = [];
  const walkJ = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walkJ(p); else if (p.endsWith('.java') && /new (Ping|ApiError)\("/.test(fs.readFileSync(p, 'utf8'))) bad.push(p); } };
  walkJ(path.join(ENGINE, 'templates/app/backend'));
  return { code: bad.length ? 1 : 0, out: bad.join(', ') };
});
test('template red: the old generator options are reported', 1, () => ({ code: genDefaults(TPL_GRADLE.replace('"skipDefaultInterface" to "false"', '"skipDefaultInterface" to "true"')) ? 0 : 1, out: '' }));
test('template green: null optional fields are left out of the JSON', 0, () => ({ code: /^spring\.jackson\.default-property-inclusion=non_null$/m.test(fs.readFileSync(path.join(ENGINE, 'templates/app/backend/src/main/resources/application.properties'), 'utf8')) ? 0 : 1, out: '' }));

// F2: the real generators must accept the contract (an unquoted ": " passed every text check in slice 03)
const genFake = (sb, map) => { sb.env.ORACUL_GENERATE_FAKE = JSON.stringify(map); };
test('contract red: --validate — the generator rejects the YAML', 1, (sb) => { genFake(sb, { backend: { code: 1, out: 'Exception: mapping values are not allowed here\n at line 1088' } }); return node(sb, 'checks/check-contract.mjs', ['--validate']); },
  (sb, r) => /backend generator rejects api\/openapi\.yaml — Exception: mapping values are not allowed here/.test(r.out) || r.out);
test('contract green: --validate — both generators accept it', 0, (sb) => { genFake(sb, {}); return node(sb, 'checks/check-contract.mjs', ['--validate']); },
  (sb, r) => (/backend generator accepts/.test(r.out) && /frontend generator accepts/.test(r.out)) || r.out);
test('contract green: --validate skips an unchanged contract (no generator call)', 0, (sb) => { gitApp(sb); genFake(sb, { backend: { code: 1, out: 'boom' } }); return node(sb, 'checks/check-contract.mjs', ['--validate']); },
  (sb, r) => /validate: api\/openapi\.yaml unchanged/.test(r.out) || r.out);
test('contract green: --validate without the generator tools → WARN, not INVALID', 0, (sb) => node(sb, 'checks/check-contract.mjs', ['--validate']),
  (sb, r) => /WARN\s+validate: backend\/gradlew not found/.test(r.out) || r.out);
test('artifacts red: the slice spec gate fails when the generator rejects the contract', 1, (sb) => { genFake(sb, { frontend: { code: 1, out: 'Error: could not parse' } }); return node(sb, 'checks/check-artifacts.mjs', ['--step', '04_build', '--slice', '01_rooms', '--stage', 'spec']); },
  (sb, r) => /contractParses\] — validate: the frontend generator rejects/.test(r.out) || r.out);

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
const lastRunOkAt = (sb) => sb.put('../../state/apps/fixture/last-run.json', JSON.stringify({ layers: { backend: { exit: 0 }, frontend: { exit: 0 } } }));
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
// FLAKY (A3): the Gradle test-retry plugin writes one <testcase> per attempt
const attempts = (sb, cls, ...oks) => sb.put(`backend/build/test-results/test/TEST-${cls}.xml`,
  `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="${cls}" tests="${oks.length}" failures="${oks.filter((o) => !o).length}" errors="0">\n${oks.map((ok) => `  <testcase name="t()" classname="${cls}" time="0.1">${ok ? '' : ASSERT}</testcase>`).join('\n')}\n</testsuite>\n`);
const oldFile = (sb) => sb.put(OLD, 'package com.oracul.app.old;\nclass OldIT { @org.junit.jupiter.api.Test void t() {} }\n');
test('flaky green: an older test that failed, then passed on retry is FLAKY, not blamed on the slice', 0, (sb) => {
  roomsFails(sb); oldFile(sb); attempts(sb, 'com.oracul.app.old.OldIT', false, true);
  const a = analyseRed({ appDir: sb.appDir, phaseDir: sb.doc(''), slice: '01_rooms', layers: { backend: { code: 1, out: 'BUILD FAILED' } }, changed: [] });
  return { code: a.verdict === 'RED' && a.flaky.join() === 'com.oracul.app.old.OldIT.t()' ? 0 : 1, out: JSON.stringify(a.wrong) };
});
test('flaky red: a slice test that passed on retry is WRONG-REASON (new tests must be deterministic)', 2, (sb) => {
  oldFile(sb); junit(sb, 'com.oracul.app.old.OldIT', ASSERT);
  attempts(sb, 'com.oracul.app.rooms.RoomsApiIT', false, true);
  return red(sb, { changed: [OLD] });
}, (sb, r) => /flaky new test/.test(r.out) || r.out);
test('flaky red: an older test that fails on every attempt is still blamed (leak)', 2, (sb) => { roomsFails(sb); oldFile(sb); attempts(sb, 'com.oracul.app.old.OldIT', false, false); return red(sb); },
  (sb, r) => /older test fails/.test(r.out) || r.out);
test('flaky green: verify reports FLAKY and records it in flaky.json', 1, (sb) => {
  attempts(sb, 'com.oracul.app.rooms.RoomsApiIT', false, true);
  const later = new Date(Date.now() + 3_600_000);
  fs.utimesSync(sb.p('backend/build/test-results/test/TEST-com.oracul.app.rooms.RoomsApiIT.xml'), later, later);
  return node(sb, 'checks/verify.mjs');
}, (sb, r) => {
  const j = JSON.parse(fs.readFileSync(path.join(sb.stateDir, 'apps/fixture/flaky.json'), 'utf8'));
  return (/FLAKY\s+com\.oracul\.app\.rooms\.RoomsApiIT\.t\(\)/.test(r.out) && j.tests['com.oracul.app.rooms.RoomsApiIT.t()']?.count === 1) || r.out;
});
test('flaky green: a test flaky in two slices is PERSISTENT', 0, (sb) => {
  const f = path.join(sb.stateDir, 'apps/fixture/flaky.json');
  recordFlaky(f, '01_rooms', ['a.B.t()']); recordFlaky(f, '02_search', ['a.B.t()']); recordFlaky(f, '02_search', ['c.D.u()']);
  return node(sb, 'bin/state.mjs', ['flaky']);
}, (sb, r) => (/PERSISTENT FLAKY a\.B\.t\(\) — seen 2×/.test(r.out) && /^FLAKY c\.D\.u\(\)/m.test(r.out)) || r.out);
test('flaky green: traceability counts a test that passed on retry as passing', 0, (sb) => {
  lastRunOkAt(sb); attempts(sb, 'com.oracul.app.rooms.RoomsApiIT', false, true);
  return node(sb, 'checks/gen-traceability.mjs');
});
test('flaky red: traceability fails a test that failed on every attempt', 1, (sb) => {
  lastRunOkAt(sb); attempts(sb, 'com.oracul.app.rooms.RoomsApiIT', false, false);
  return node(sb, 'checks/gen-traceability.mjs');
});
// WP-H: a Spring context that does not start — RED only for a production cause named in the slice spec
const ctxFail = (cause, frame) => `<error type="java.lang.IllegalStateException" message="Failed to load ApplicationContext for [WebMergedContextConfiguration]">java.lang.IllegalStateException: Failed to load ApplicationContext
	at org.springframework.test.context.cache.DefaultCacheAwareContextLoaderDelegate.loadContext(X.java:1)
Caused by: org.springframework.beans.factory.BeanCreationException: Error creating bean
	at org.springframework.beans.Y.z(Y.java:1)
Caused by: ${cause}
${frame ? `	at ${frame}(F.java:12)\n` : ''}	at org.springframework.Z.z(Z.java:1)</error>`;
const PROD_PROPS = 'backend/src/main/java/com/oracul/app/rooms/RoomsProperties.java';
test('startup green: the context fails in production code named in the slice spec → RED (listed for the reviewer)', 0, (sb) => {
  sb.put(PROD_PROPS, 'class RoomsProperties {}'); sb.edit(SPEC, '- Ranges & invariants: none', '- Ranges & invariants: none\n- Config: RoomsProperties.callbackUri accepts /callback');
  roomsFails(sb, ctxFail('java.lang.IllegalArgumentException: callback URI must end with /auth/callback', 'com.oracul.app.rooms.RoomsProperties.validate'));
  const a = analyseRed({ appDir: sb.appDir, phaseDir: sb.doc(''), slice: '01_rooms', layers: { backend: { code: 1, out: 'BUILD FAILED' } }, changed: [] });
  const md = renderEvidence(a, { slice: '01_rooms', frs: ['FR-1'] });
  return { code: a.verdict === 'RED' && a.startup.length === 1 && /## Red by startup only/.test(md) ? 0 : 1, out: JSON.stringify(a.wrong) };
});
test('startup green: a property binding failure named in the spec → RED', 0, (sb) => {
  sb.edit(SPEC, '- Ranges & invariants: none', '- Ranges & invariants: none\n- Config: app.rooms.callback-uri');
  roomsFails(sb, ctxFail("org.springframework.boot.context.properties.bind.BindException: Failed to bind properties under 'app.rooms.callback-uri' to java.net.URI"));
  return red(sb);
});
test('startup red: the context fails in test configuration code → test bug', 2, (sb) => {
  sb.edit(SPEC, '- Ranges & invariants: none', '- Ranges & invariants: none\n- Config: TestcontainersConfiguration');
  sb.put('backend/src/test/java/com/oracul/app/TestcontainersConfiguration.java', 'class TestcontainersConfiguration {}');
  roomsFails(sb, ctxFail('java.lang.IllegalStateException: no container', 'com.oracul.app.TestcontainersConfiguration.postgres'));
  return red(sb);
}, (sb, r) => /test configuration bug \(cause thrown in test code\)/.test(r.out) || r.out);
test('startup red: a production cause the slice spec never names → test bug', 2, (sb) => {
  sb.put(PROD_PROPS, 'class RoomsProperties {}');
  roomsFails(sb, ctxFail('java.lang.IllegalArgumentException: bad', 'com.oracul.app.rooms.RoomsProperties.validate'));
  return red(sb);
}, (sb, r) => /not named in the slice spec/.test(r.out) || r.out);
test('startup red: an older test whose context fails is not the slice\'s RED', 2, (sb) => {
  sb.put(PROD_PROPS, 'class RoomsProperties {}'); sb.edit(SPEC, '- Ranges & invariants: none', '- Ranges & invariants: none\n- Config: RoomsProperties');
  roomsFails(sb); oldFile(sb); junit(sb, 'com.oracul.app.old.OldIT', ctxFail('java.lang.IllegalArgumentException: bad', 'com.oracul.app.rooms.RoomsProperties.validate'));
  return red(sb);
}, (sb, r) => /an older test \(not the slice's\)/.test(r.out) || r.out);
const fe = (sb, out, opts = {}) => red(sb, { slice: '02_search', layers: { frontend: { code: 1, out } }, ...opts });
test('red green: frontend slice spec fails', 0, (sb) => fe(sb, ' FAIL  src/app/search/search.spec.ts > search > filters\nAssertionError: expected [] to have length 1'));
test('red red: frontend older spec broken by the new tests', 2, (sb) => {
  sb.put('frontend/src/app/rooms/rooms.spec.ts', "describe('rooms', () => {});\n");
  return fe(sb, ' FAIL  src/app/search/search.spec.ts > search\n FAIL  src/app/rooms/rooms.spec.ts > rooms > lists');
});
test('red red: frontend TestBed misses a provider', 2, (sb) => fe(sb, ' FAIL  src/app/search/search.spec.ts\nNullInjectorError: No provider for HttpClient!'));

// ---------------- related tests + red-check --scope slice (A2)
test('related green: tagged + superseded + changed tests, nothing unrelated', 0, (sb) => {
  oldTest(sb);
  sb.put('backend/src/test/java/com/oracul/app/other/OtherIT.java', 'class OtherIT {}');
  sb.put('frontend/src/app/rooms/rooms.spec.ts', "describe('rooms', () => {});");
  sb.edit(SPEC, '- Changes earlier behaviour: none', `- Changes earlier behaviour: 201 → 200 (tests: ${OLD})`);
  const r = relatedTests({ appDir: sb.appDir, phaseDir: sb.doc(''), slice: '01_rooms', changed: ['frontend/src/app/rooms/rooms.spec.ts'] });
  const ok = r.backend.includes('backend/src/test/java/com/oracul/app/rooms/RoomsApiIT.java') && r.backend.includes(OLD)
    && !r.backend.some((f) => /OtherIT/.test(f)) && r.frontend.join() === 'frontend/src/app/rooms/rooms.spec.ts'
    && r.e2e.includes('e2e/tests/rooms.spec.ts') && !r.frontend.includes('frontend/src/app/search/search.spec.ts');
  return { code: ok ? 0 : 1, out: JSON.stringify(r) };
});
test('related green: a changed README relates to exactly the tests that read it (G8)', 0, (sb) => {
  sb.put('backend/src/test/java/com/oracul/app/ReadmeTest.java', 'class ReadmeTest { java.nio.file.Path p = java.nio.file.Path.of("../README.md"); }');
  sb.put('README.md', '# x');
  const r = relatedTests({ appDir: sb.appDir, phaseDir: sb.doc(''), slice: '02_search', changed: ['README.md'] });
  return { code: r.backend.join() === 'backend/src/test/java/com/oracul/app/ReadmeTest.java' && r.e2e.length === 0 ? 0 : 1, out: JSON.stringify(r) };
});
test('related green: a doc no test names relates to no test', 0, (sb) => {
  const r = relatedTests({ appDir: sb.appDir, phaseDir: sb.doc(''), slice: '02_search', changed: ['docs/notes.md'] });
  return { code: r.backend.length === 0 && r.e2e.length === 0 && r.frontend.join() === 'frontend/src/app/search/search.spec.ts' ? 0 : 1, out: JSON.stringify(r) };
});
test('related red: unknown slice → null', 1, (sb) => ({ code: relatedTests({ appDir: sb.appDir, phaseDir: sb.doc(''), slice: '09_x' }) ? 0 : 1, out: '' }));
test('related green: a changed file that no longer exists is left out', 0, (sb) => {
  const r = relatedTests({ appDir: sb.appDir, phaseDir: sb.doc(''), slice: '01_rooms', changed: ['backend/src/test/java/com/oracul/app/GoneIT.java'] });
  return { code: r.backend.some((f) => /GoneIT/.test(f)) ? 1 : 0, out: JSON.stringify(r) };
});
test('red-check green: --scope slice runs only the related backend classes', 0, (sb) => {
  oldTest(sb);
  return node(sb, 'bin/red-check.mjs', ['--slice', '01_rooms', '--scope', 'slice', '--dry-run']);
}, (sb, r) => (/backend: \.\/gradlew test --tests com\.oracul\.app\.rooms\.RoomsApiIT --console=plain --continue/.test(r.out) && !/OldIT/.test(r.out)
  && !fs.existsSync(sb.doc('04_build/01_rooms/red-evidence.md.new'))) || r.out);
test('red-check green: --scope full (default) runs the whole layer', 0, (sb) => node(sb, 'bin/red-check.mjs', ['--slice', '01_rooms', '--dry-run']),
  (sb, r) => (/backend: \.\/gradlew test --console=plain --continue\s*$/m.test(r.out) && !/--tests/.test(r.out)) || r.out);
test('red-check green: frontend related specs use ng test --include', 0, (sb) => node(sb, 'bin/red-check.mjs', ['--slice', '02_search', '--scope', 'slice', '--dry-run']),
  (sb, r) => /frontend: npm run test:ci --silent -- --include src\/app\/search\/search\.spec\.ts/.test(r.out) || r.out);
test('red-check green: frontend without `ng test` runs in full and says so', 0, (sb) => {
  sb.edit('frontend/package.json', /"test:ci": "[^"]*"/, '"test:ci": "vitest run"');
  return node(sb, 'bin/red-check.mjs', ['--slice', '02_search', '--scope', 'slice', '--dry-run']);
}, (sb, r) => (/frontend: npm run test:ci --silent\s+# frontend test:ci is not `ng test`/.test(r.out)) || r.out);
// Gradle applies a task option to the task right before it: --tests must follow `test` (issue 8, slice 03)
test('gradle green: every filtered command puts --tests right after test', 0, (sb) => {
  const f = ['backend/src/test/java/com/oracul/app/rooms/RoomsApiIT.java', OLD];
  const cmds = [layerCommand('backend', sb.appDir, f), layerCommand('backend', sb.appDir, f, { gradleTasks: ['test', 'jacocoTestReport'], extraGradle: ['-q'] })];
  return { code: cmds.every((c) => gradleFilterValid(c.args) && c.args.filter((a) => a === '--tests').length === 2) ? 0 : 1, out: cmds.map((c) => c.args.join(' ')).join(' | ') };
});
test('gradle red: --tests after jacocoTestReport (the slice-03 command) is invalid', 1, () => ({ code: gradleFilterValid(['test', 'jacocoTestReport', '--console=plain', '-q', '--tests', 'a.B']) ? 0 : 1, out: '' }));
test('red-check red: slice not in the plan', 1, (sb) => node(sb, 'bin/red-check.mjs', ['--slice', '09_nope', '--dry-run']));
test('red-check red: unknown --scope', 1, (sb) => node(sb, 'bin/red-check.mjs', ['--slice', '01_rooms', '--scope', 'some', '--dry-run']));
test('red-check green: --dry-run writes no evidence', 0, (sb) => { sb.rm('docs/phase-01_mvp/04_build/01_rooms/red-evidence.md'); return node(sb, 'bin/red-check.mjs', ['--slice', '01_rooms', '--scope', 'slice', '--dry-run']); },
  (sb) => !fs.existsSync(sb.doc('04_build/01_rooms/red-evidence.md')) || 'evidence written by a dry run');
test('evidence green: "Scope: slice" line, RESULT last', 0, (sb) => {
  roomsFails(sb);
  const a = analyseRed({ appDir: sb.appDir, phaseDir: sb.doc(''), slice: '01_rooms', layers: { backend: { code: 1, out: 'BUILD FAILED' } }, changed: [] });
  const md = renderEvidence(a, { slice: '01_rooms', frs: ['FR-1'], scope: 'slice' });
  return { code: /^Scope: slice\b/m.test(md) && /RESULT: RED\n$/.test(md) ? 0 : 1, out: md };
});
test('evidence green: an old red-evidence.md without a Scope line still passes the artifact check', 0, (sb) => {
  const f = 'docs/phase-01_mvp/04_build/01_rooms/red-evidence.md';
  sb.put(f, sb.read(f).replace(/^Scope:.*\n/m, ''));
  return node(sb, 'checks/check-artifacts.mjs', ['--step', '04_build', '--slice', '01_rooms', '--stage', 'red']);
});

// ---------------- WP-F: compile first, compiler output verbatim, labelled by where the error is
const JAVAC = (sb, rel, msg = 'cannot find symbol') => `${sb.p(rel)}:12: error: ${msg}\n    symbol:   class ProviderCode\n    location: class X`;
const fakeCompile = (sb, map) => { sb.env.ORACUL_COMPILE_FAKE = JSON.stringify(map); };
test('compile green: labels main / generated / test-new / test-old from the compiler paths', 0, (sb) => {
  const out = [JAVAC(sb, 'backend/src/main/java/com/oracul/app/X.java'), JAVAC(sb, 'backend/build/generated/openapi/src/main/java/com/oracul/app/api/A.java'),
    JAVAC(sb, 'backend/src/test/java/com/oracul/app/NewIT.java'), JAVAC(sb, OLD)].join('\n');
  const d = diagnostics(sb.appDir, [{ layer: 'backend', stage: 'main', code: 1, out }], ['backend/src/test/java/com/oracul/app/NewIT.java']);
  const ok = d.labels.main === 1 && d.labels.generated === 1 && d.labels['test-new'] === 1 && d.labels['test-old'] === 1 && d.verbatim.some((l) => /symbol:\s+class ProviderCode/.test(l));
  return { code: ok ? 0 : 1, out: JSON.stringify(d.labels) };
});
test('compile green: tsc paths (relative to frontend/) are labelled too', 0, (sb) => {
  const d = diagnostics(sb.appDir, [{ layer: 'frontend', stage: 'main', code: 2, out: "src/app/runs/run.ts(4,7): error TS2322: Type 'string' is not assignable to type 'Mode'.\nsrc/app/runs/run.spec.ts(9,1): error TS2304: Cannot find name 'x'." }], []);
  return { code: d.labels.main === 1 && d.labels['test-old'] === 1 && d.files[0].rel === 'frontend/src/app/runs/run.ts' ? 0 : 1, out: JSON.stringify(d.files) };
});
test('compile green: an unrecognised compiler format still shows its output', 0, (sb) => {
  const d = diagnostics(sb.appDir, [{ layer: 'backend', stage: 'main', code: 1, out: 'weird failure line\nFAILURE: Build failed with an exception.' }], []);
  return { code: d.count === 1 && d.verbatim.some((l) => /weird failure line/.test(l)) && /format not recognised/.test(summaryLine(d)) ? 0 : 1, out: d.verbatim.join('|') };
});
test('compile-check red: production code does not compile → exit 1, labelled diagnostics', 1, (sb) => { fakeCompile(sb, { 'backend:main': { code: 1, out: JAVAC(sb, 'backend/src/main/java/com/oracul/app/X.java') } }); return node(sb, 'bin/compile-check.mjs', ['--layer', 'backend']); },
  (sb, r) => (/FAIL\s+backend main/.test(r.out) && /SKIP\s+backend tests/.test(r.out) && /COMPILE ERRORS: 1 \(main 1\)/.test(r.out) && /X\.java:12: error: cannot find symbol/.test(r.out)) || r.out);
test('compile-check green: everything compiles → exit 0', 0, (sb) => { fakeCompile(sb, {}); return node(sb, 'bin/compile-check.mjs'); }, (sb, r) => /COMPILE OK/.test(r.out) || r.out);
test('compile-check red: an older test that no longer compiles and is not listed → UNLISTED', 1, (sb) => {
  oldFile(sb); fakeCompile(sb, { 'backend:tests': { code: 1, out: JAVAC(sb, OLD) } });
  return node(sb, 'bin/compile-check.mjs', ['--layer', 'backend', '--stage', 'tests', '--slice', '01_rooms', '--require-listed']);
}, (sb, r) => new RegExp(`UNLISTED ${OLD}`).test(r.out) || r.out);
test('compile-check green: the same older test listed under "Changes earlier behaviour" is not UNLISTED', 1, (sb) => {
  oldFile(sb); fakeCompile(sb, { 'backend:tests': { code: 1, out: JAVAC(sb, OLD) } });
  sb.edit(SPEC, '- Changes earlier behaviour: none', `- Changes earlier behaviour: field renamed (tests: ${OLD})`);
  return node(sb, 'bin/compile-check.mjs', ['--layer', 'backend', '--stage', 'tests', '--slice', '01_rooms', '--require-listed']);
}, (sb, r) => !/UNLISTED/.test(r.out) || r.out);
function gitApp(sb, msg = 'phase-01_mvp 00_setup: skeleton') { // hoisted: used by earlier sections too
  for (const a of [['init', '-q'], ['add', '-A'], ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', msg]]) spawnSync('git', a, { cwd: sb.appDir });
}
test('compile-check green: contract unchanged since the last finished slice → nothing to check', 0, (sb) => { gitApp(sb); fakeCompile(sb, { 'backend:main': { code: 1, out: 'x' } }); return node(sb, 'bin/compile-check.mjs', ['--if-contract-changed']); },
  (sb, r) => /unchanged since the last finished slice/.test(r.out) || r.out);
test('compile-check red: contract changed since the last finished slice → it compiles (and fails here)', 1, (sb) => {
  gitApp(sb); sb.edit('api/openapi.yaml', 'operationId: listRooms', 'operationId: listAllRooms');
  fakeCompile(sb, { 'backend:main': { code: 1, out: JAVAC(sb, 'backend/src/main/java/com/oracul/app/X.java') } });
  return node(sb, 'bin/compile-check.mjs', ['--if-contract-changed']);
});
test('red-check red: backend does not compile → WRONG-REASON at once, compiler lines in the evidence, no test run', 2, (sb) => {
  fakeCompile(sb, { 'backend:main': { code: 1, out: JAVAC(sb, 'backend/src/main/java/com/oracul/app/X.java') } });
  return node(sb, 'bin/red-check.mjs', ['--slice', '01_rooms', '--scope', 'slice']);
}, (sb, r) => {
  const ev = sb.read('docs/phase-01_mvp/04_build/01_rooms/red-evidence.md');
  return (/compile error in main \(1\) — production code does not compile/.test(r.out) && /## Compiler errors/.test(ev) && /X\.java:12: error: cannot find symbol/.test(ev) && !/tests \((related|whole layer)\) took/.test(r.out)) || r.out;
});
test('red green: Angular test build with a TS error in a new spec is labelled test-new', 2, (sb) => fe(sb, 'src/app/search/search.spec.ts:3:5 - error TS2304: Cannot find name \'SearchPage\'.', { changed: ['frontend/src/app/search/search.spec.ts'] }),
  (sb, r) => /frontend: compile error in test-new \(1\) — a new or changed test does not compile/.test(r.out) || r.out);

// ---------------- verify --reuse-if-fresh (slice close) — the fixture has no gradlew, so a FULL run fails with exit 1
const lastRunFile = (sb) => path.join(sb.stateDir, 'apps/fixture/last-run.json');
const touchLater = (sb, rel) => { const t = new Date(Date.now() + 3_600_000); if (!fs.existsSync(sb.p(rel))) sb.put(rel, 'x'); fs.utimesSync(sb.p(rel), t, t); };
const reuse = (sb) => node(sb, 'checks/verify.mjs', ['--reuse-if-fresh']);
test('verify green: --reuse-if-fresh reuses a full GREEN verify when nothing changed (writes nothing)', 0, (sb) => reuse(sb),
  (sb, r) => (/verify: reusing the full GREEN verify of/.test(r.out) && !fs.existsSync(lastRunFile(sb))) || r.out);
for (const [what, rel] of [
  ['a coverage report', 'backend/build/reports/jacoco/test/jacocoTestReport.xml'],
  ['a JUnit XML', 'backend/build/test-results/test/TEST-com.oracul.app.rooms.RoomsApiIT.xml'],
  ['the frontend coverage', 'frontend/coverage/frontend/coverage-summary.json'],
  ['a source file', 'backend/src/test/java/com/oracul/app/rooms/RoomsApiIT.java'],
  ['the contract', 'api/openapi.yaml'],
]) test(`verify red: --reuse-if-fresh runs a full verify when ${what} is newer than the last verify`, 1, (sb) => { touchLater(sb, rel); return reuse(sb); },
  (sb, r) => (/running a full verify/.test(r.out) && r.out.includes(rel) && /VERIFY RED/.test(r.out)) || r.out);
test('verify red: --reuse-if-fresh runs a full verify when the last verify was RED', 1, (sb) => {
  sb.state({ lastVerify: { at: new Date(Date.now() + 60_000).toISOString(), result: 'RED', failing: ['x'] } }); return reuse(sb);
}, (sb, r) => /the last verify is RED — running a full verify/.test(r.out) || r.out);
test('verify red: --reuse-if-fresh runs a full verify when the last verify was --quick', 1, (sb) => {
  sb.state({ lastVerify: { at: new Date(Date.now() + 60_000).toISOString(), result: 'GREEN', failing: [], quick: true } }); return reuse(sb);
}, (sb, r) => /--quick \(no tests ran\) — running a full verify/.test(r.out) || r.out);
test('verify red: --reuse-if-fresh runs a full verify when there was no verify yet', 1, (sb) => { sb.state({ lastVerify: null }); return reuse(sb); },
  (sb, r) => /no earlier verify — running a full verify/.test(r.out) || r.out);
test('verify green: a newer file only in the generated client (frontend/src/app/api) is ignored', 0, (sb) => { touchLater(sb, 'frontend/src/app/api/rooms.service.ts'); return reuse(sb); },
  (sb, r) => /reusing the full GREEN verify/.test(r.out) || r.out);

// ---------------- verify --related (A5): development loop only, never the slice gate
test('verify green: --related runs only the related tests and skips coverage', 1, (sb) => { sb.state({ slice: '01_rooms', step: '04_build' }); return node(sb, 'checks/verify.mjs', ['--related']); },
  (sb, r) => (/== backend: \.\/gradlew test --tests com\.oracul\.app\.rooms\.RoomsApiIT --console=plain -q ==/.test(r.out)
    && /SKIP\s+frontend: no related tests/.test(r.out) && /SKIP\s+check-coverage: related tests only/.test(r.out) && /VERIFY \(related tests\) RED/.test(r.out)
    && JSON.parse(fs.readFileSync(path.join(sb.stateDir, 'apps/fixture/state.json'), 'utf8')).lastVerify.related === true
    && !fs.existsSync(lastRunFile(sb))) || r.out);
test('verify red: --related without a slice is refused', 1, (sb) => node(sb, 'checks/verify.mjs', ['--related']), (sb, r) => /--slice <s> required/.test(r.out) || r.out);
test('verify green: --related includes the tests that failed in the previous run', 1, (sb) => {
  sb.state({ slice: '01_rooms', step: '04_build' });
  sb.put('backend/src/test/java/com/oracul/app/other/OtherIT.java', 'class OtherIT {}');
  sb.put('../../state/apps/fixture/last-failures.json', JSON.stringify({ files: ['backend/src/test/java/com/oracul/app/other/OtherIT.java'] }));
  return node(sb, 'checks/verify.mjs', ['--related']);
}, (sb, r) => /--tests com\.oracul\.app\.other\.OtherIT/.test(r.out) || r.out);
test('verify red: --reuse-if-fresh never reuses a related-only GREEN verify', 1, (sb) => {
  sb.state({ lastVerify: { at: new Date(Date.now() + 60_000).toISOString(), result: 'GREEN', failing: [], related: true } }); return reuse(sb);
}, (sb, r) => /the last verify ran the related tests only — running a full verify/.test(r.out) || r.out);
test('stop red: a related-only GREEN verify is not a finished build', 2, (sb) => {
  sb.state({ step: '04_build', lastVerify: { at: new Date(Date.now() + 60_000).toISOString(), result: 'GREEN', failing: [], related: true } });
  return hook(sb, 'stop', { stop_hook_active: false });
});

// ---------------- WP-K: older failing tests rerun alone in a full verify → FALLOUT (broken by a change) / LEAK (state)
test('isolation green: still failing alone = FALLOUT, passing alone = LEAK', 0, () => {
  const v = isolationVerdicts(['a/AIT.java', 'b/BIT.java'], ['a/AIT.java']);
  return { code: v.fallout.join() === 'a/AIT.java' && v.leak.join() === 'b/BIT.java' ? 0 : 1, out: JSON.stringify(v) };
});
test('isolation red: an older test that fails in the full verify is rerun and labelled', 1, (sb) => {
  sb.state({ slice: '01_rooms', step: '04_build' }); oldFile(sb); attempts(sb, 'com.oracul.app.old.OldIT', false);
  const later = new Date(Date.now() + 3_600_000);
  fs.utimesSync(sb.p('backend/build/test-results/test/TEST-com.oracul.app.old.OldIT.xml'), later, later);
  return node(sb, 'checks/verify.mjs');
}, (sb, r) => (/isolation: 1 older failing test file/.test(r.out) && new RegExp(`FALLOUT\\s+${OLD.replace(/\./g, '\\.')} — fails on its own`).test(r.out)) || r.out);
test('isolation green: a failing test of the current slice is not "older" — no isolation rerun', 1, (sb) => {
  sb.state({ slice: '01_rooms', step: '04_build' }); attempts(sb, 'com.oracul.app.rooms.RoomsApiIT', false);
  const later = new Date(Date.now() + 3_600_000);
  fs.utimesSync(sb.p('backend/build/test-results/test/TEST-com.oracul.app.rooms.RoomsApiIT.xml'), later, later);
  return node(sb, 'checks/verify.mjs');
}, (sb, r) => !/isolation:/.test(r.out) || r.out);
test('isolation green: a related-only verify never runs the isolation', 1, (sb) => {
  sb.state({ slice: '01_rooms', step: '04_build' }); oldFile(sb); attempts(sb, 'com.oracul.app.old.OldIT', false);
  return node(sb, 'checks/verify.mjs', ['--related']);
}, (sb, r) => !/isolation:/.test(r.out) || r.out);

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

const lastRunOk = (sb) => sb.put('../../state/apps/fixture/last-run.json', JSON.stringify({ layers: { backend: { exit: 0 }, frontend: { exit: 0 } } }));
test('gen-traceability green: Playwright rootDir reached through a symlink still maps the E2E tests', 0, (sb) => {
  lastRunOk(sb);
  fs.symlinkSync(sb.p('e2e'), sb.p('e2e-link'));
  sb.edit('e2e/report/results.json', sb.p('e2e/tests'), sb.p('e2e-link/tests'));
  return node(sb, 'checks/gen-traceability.mjs');
}, (sb) => /rooms\.spec\.ts` \(pass\)/.test(sb.read('docs/phase-01_mvp/05_release/qa/traceability.md')) || 'e2e test not mapped');
test('gen-traceability red: Playwright rootDir elsewhere → E2E test unknown → ✘', 1, (sb) => {
  lastRunOk(sb);
  fs.mkdirSync(sb.p('other/tests'), { recursive: true });
  sb.edit('e2e/report/results.json', sb.p('e2e/tests'), sb.p('other/tests'));
  return node(sb, 'checks/gen-traceability.mjs');
});

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

// ---------------- timings (A1): every subStep change is logged next to state.json; logging never fails a command
const TIMINGS = (sb) => path.join(sb.stateDir, 'apps/fixture/timings.jsonl');
const timingRows = (sb) => (fs.existsSync(TIMINGS(sb)) ? fs.readFileSync(TIMINGS(sb), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
test('timings green: set subStep logs from → to with slice and round', 0, (sb) => {
  sb.state({ slice: '01_rooms', round: 2, subStep: 'green' });
  return node(sb, 'bin/state.mjs', ['set', 'subStep', 'review']);
}, (sb) => { const r = timingRows(sb); return (r.length === 1 && r[0].from === 'green' && r[0].to === 'review' && r[0].slice === '01_rooms' && r[0].round === 2 && !!r[0].at) || JSON.stringify(r); });
test('timings green: setting the same subStep again logs nothing', 0, (sb) => node(sb, 'bin/state.mjs', ['set', 'subStep', 'none']), (sb) => timingRows(sb).length === 0 || 'logged a no-op');
test('timings red: an unknown subStep is refused and not logged', 1, (sb) => node(sb, 'bin/state.mjs', ['set', 'subStep', 'bogus']), (sb) => timingRows(sb).length === 0 || 'logged a refused change');
test('timings green: an unwritable timings file never fails set subStep', 0, (sb) => { fs.mkdirSync(TIMINGS(sb), { recursive: true }); return node(sb, 'bin/state.mjs', ['set', 'subStep', 'red']); },
  (sb) => JSON.parse(fs.readFileSync(path.join(sb.stateDir, 'apps/fixture/state.json'), 'utf8')).subStep === 'red' || 'subStep not stored');
test('timings green: summary per slice and subStep, malformed lines skipped', 0, () => {
  const t = (s) => new Date(Date.parse('2026-10-04T10:00:00Z') + s * 1000).toISOString();
  const text = [
    JSON.stringify({ at: t(0), slice: '01_a', from: 'none', to: 'red' }), 'not json', JSON.stringify({ to: 'x' }),
    JSON.stringify({ at: t(600), slice: '01_a', from: 'red', to: 'green' }), JSON.stringify({ at: t(900), slice: '01_a', from: 'green', to: 'red' }),
    JSON.stringify({ at: t(960), slice: '01_a', from: 'red', to: 'none' }), JSON.stringify({ at: t(1000), slice: '02_b', from: 'none', to: 'spec' }),
  ].join('\n');
  const sum = summariseTimings(text, Date.parse(t(1060)));
  const a = sum.find((x) => x.slice === '01_a');
  const b = sum.find((x) => x.slice === '02_b');
  const red = a?.steps.find((x) => x.subStep === 'red')?.ms;
  const ok = sum.length === 2 && red === 660_000 && a.total === 960_000 && b.total === 60_000;
  return { code: ok ? 0 : 1, out: JSON.stringify(sum) };
});
test('timings green: state.mjs timings prints the summary', 0, (sb) => {
  sb.state({ slice: '01_rooms', subStep: 'none' });
  node(sb, 'bin/state.mjs', ['set', 'subStep', 'red']);
  return node(sb, 'bin/state.mjs', ['timings']);
}, (sb, r) => /01_rooms: \d+s — red \d+s/.test(r.out) || r.out);
test('slow report green: slowest classes and Spring context starts from the JUnit XML', 0, (sb) => {
  const dir = sb.p('backend/build/test-results/test');
  sb.put('backend/build/test-results/test/TEST-a.SlowIT.xml', '<testsuite name="a.SlowIT" tests="3" time="42.5"><system-out>Started SlowIT in 9.1 seconds</system-out></testsuite>');
  sb.put('backend/build/test-results/test/TEST-a.FastTest.xml', '<testsuite name="a.FastTest" tests="1" time="0.2"><system-out>Started FastTest in 1.0 seconds</system-out></testsuite>');
  const top = slowestClasses(dir, 10);
  const ok = top[0].name === 'a.SlowIT' && top[0].seconds === 42.5 && top[0].tests === 3 && springContexts(dir) >= 2;
  return { code: ok ? 0 : 1, out: JSON.stringify(top) };
});
test('slow report green: no test results → empty, no error', 0, (sb) => { sb.rm('backend/build/test-results'); return { code: slowestClasses(sb.p('backend/build/test-results/test')).length ? 1 : 0, out: '' }; });

// ---------------- migrate.mjs (B2): existing apps get what new apps are scaffolded with — only known text is patched
const OLD_PW = "import { defineConfig, devices } from '@playwright/test';\n\n// Runs against the Docker stack (docker compose up). Reports feed gen-traceability and check-artifacts.\nexport default defineConfig({\n  testDir: './tests',\n  timeout: 30_000,\n  retries: 0,\n  reporter: [\n    ['list'],\n    ['json', { outputFile: 'report/results.json' }],\n    ['junit', { outputFile: 'report/junit.xml' }],\n  ],\n  use: { baseURL: process.env.BASE_URL ?? 'http://localhost:4200', trace: 'retain-on-failure' },\n  maxFailures: 10,\n});\n";
const OLD_DF = "# build context = app root (needs api/openapi.yaml)\nFROM eclipse-temurin:25-jdk AS build\nWORKDIR /src\nCOPY api ./api\nCOPY backend ./backend\nWORKDIR /src/backend\nRUN ./gradlew bootJar --no-daemon -q\n\nFROM eclipse-temurin:25-jre\nWORKDIR /app\nCOPY --from=build /src/backend/build/libs/*.jar app.jar\nEXPOSE 8080\nENTRYPOINT [\"java\", \"-jar\", \"/app/app.jar\"]\n";
const OLD_GRADLE = 'plugins {\n    java\n    id("org.openapi.generator") version "7.25.0"\n}\n\ntasks.withType<Test> {\n    useJUnitPlatform()\n    finalizedBy(tasks.jacocoTestReport)\n}\n';
const oldApp = (sb) => { sb.put('e2e/playwright.config.ts', OLD_PW); sb.put('backend/Dockerfile', OLD_DF); sb.put('backend/build.gradle.kts', OLD_GRADLE); sb.put('.gitignore', 'node_modules/\n'); };
const migrate = (sb, a = []) => { sb.env.ORACUL_TEST_RETRY_VERSION = '9.9.9'; return node(sb, 'bin/migrate.mjs', a); };
test('migrate red: an old app has migrations pending → --check exit 10, nothing changed', 10, (sb) => { oldApp(sb); return migrate(sb, ['--check', '--speed']); },
  (sb, r) => (/MIGRATION PENDING \(5\)/.test(r.out) && sb.read('backend/Dockerfile') === OLD_DF) || r.out);
const OLD_GEN = 'openApiGenerate {\n    configOptions.set(mapOf("interfaceOnly" to "true", "skipDefaultInterface" to "true"))\n}\n';
test('migrate red: contract set pending on an old app (default methods, marker files)', 10, (sb) => { sb.put('backend/build.gradle.kts', OLD_GEN); return migrate(sb, ['--check', '--contract']); },
  (sb, r) => (/default-interface/.test(r.out) && /marker-java/.test(r.out) && /marker-ts/.test(r.out)) || r.out);
test('migrate green: contract set — 501 defaults on, marker files from the templates, nothing else changed', 0, (sb) => { sb.put('backend/build.gradle.kts', OLD_GEN); return migrate(sb, ['--contract']); }, (sb, r) => {
  const ok = /"skipDefaultInterface" to "false"/.test(sb.read('backend/build.gradle.kts')) && /"interfaceOnly" to "true"/.test(sb.read('backend/build.gradle.kts'))
    && sb.read('backend/src/main/java/com/oracul/app/common/NotImplementedException.java') === fs.readFileSync(path.join(ENGINE, 'templates/app/backend/src/main/java/com/oracul/app/common/NotImplementedException.java'), 'utf8')
    && fs.existsSync(sb.p('frontend/src/app/not-implemented.ts')) && !fs.existsSync(sb.p('backend/src/main/resources/application.properties'));
  return ok || r.out;
});
test('migrate green: applies every item; the result is what new apps get', 0, (sb) => { oldApp(sb); return migrate(sb); }, (sb, r) => {
  const pw = sb.read('e2e/playwright.config.ts'), g = sb.read('backend/build.gradle.kts');
  const ok = scratchSupported(pw) && /maxFailures: 10/.test(pw) && /outputDir: process\.env\.E2E_OUTPUT_DIR \?\? 'test-results'/.test(pw)
    && sb.read('backend/Dockerfile') === fs.readFileSync(path.join(ENGINE, 'templates/app/backend/Dockerfile'), 'utf8')
    && /id\("org\.gradle\.test-retry"\) version "9\.9\.9"/.test(g) && /maxRetries\.set\(1\)/.test(g)
    && fs.existsSync(sb.p('.dockerignore')) && /e2e\/report-focus\//.test(sb.read('.gitignore'));
  return ok || r.out;
});
test('migrate green: a second run changes nothing and --check is clean', 0, (sb) => { oldApp(sb); migrate(sb); const snap = sb.read('backend/build.gradle.kts'); const c = migrate(sb, ['--check']); return { code: c.code === 0 && sb.read('backend/build.gradle.kts') === snap ? 0 : 1, out: c.out }; });
test('migrate red: a customised Dockerfile is refused, not overwritten, and not asked again', 0, (sb) => {
  oldApp(sb); sb.put('backend/Dockerfile', OLD_DF.replace('-q', '-q --info'));
  const a = migrate(sb);
  const c = migrate(sb, ['--check']);
  return { code: /REFUSED\s+backend-dockerfile/.test(a.out) && /--info/.test(sb.read('backend/Dockerfile')) && c.code === 0 ? 0 : 1, out: a.out + c.out };
});
test('migrate red: a customised Playwright config (own outputDir) is refused', 0, (sb) => {
  oldApp(sb); sb.put('e2e/playwright.config.ts', OLD_PW.replace("testDir: './tests',", "testDir: './tests',\n  outputDir: 'out',"));
  const a = migrate(sb);
  return { code: /REFUSED\s+playwright-report-dirs/.test(a.out) && /outputDir: 'out'/.test(sb.read('e2e/playwright.config.ts')) ? 0 : 1, out: a.out };
});
test('migrate red: refuses to run mid-slice', 1, (sb) => { oldApp(sb); sb.state({ subStep: 'green' }); return migrate(sb); }, (sb) => sb.read('backend/Dockerfile') === OLD_DF || 'changed mid-slice');
test('migrate green: --check works mid-slice and changes nothing', 10, (sb) => { oldApp(sb); sb.state({ subStep: 'green' }); return migrate(sb, ['--check']); });

// ---------------- WP-G: contract sync — builders make production compile again, check-sync proves no behaviour
const CTRL = 'backend/src/main/java/com/oracul/app/rooms/RoomsController.java';
const CTRL_V1 = 'package com.oracul.app.rooms;\n\nimport com.oracul.app.api.RoomsApi;\n\npublic class RoomsController implements RoomsApi {\n    @Override\n    public ResponseEntity<RoomDto> listRooms(String q) {\n        RoomDto dto = mapper.toDto(service.all(q));\n        return ResponseEntity.ok(dto);\n    }\n}\n';
const syncBase = (sb) => { sb.put(CTRL, CTRL_V1); gitApp(sb); };
const STUB = '    @Override\n    public ResponseEntity<RoomDto> getRoom(String id) {\n        throw new NotImplementedException();\n    }\n}\n';
const addToCtrl = (sb, text) => sb.put(CTRL, CTRL_V1.replace(/}\n$/, text));
test('sync green: a marker stub for a method the interface now requires', 0, (sb) => {
  syncBase(sb); addToCtrl(sb, STUB); sb.edit(CTRL, 'import com.oracul.app.api.RoomsApi;', 'import com.oracul.app.api.RoomsApi;\nimport com.oracul.app.common.NotImplementedException;');
  return node(sb, 'checks/check-sync.mjs');
});
test('sync red: behaviour added during the sync', 1, (sb) => { syncBase(sb); addToCtrl(sb, STUB.replace('throw new NotImplementedException();', 'return ResponseEntity.ok(service.one(id));')); return node(sb, 'checks/check-sync.mjs'); },
  (sb, r) => (/SYNC VIOLATIONS: 1/.test(r.out) && /return ResponseEntity\.ok\(service\.one\(id\)\)/.test(r.out)) || r.out);
test('sync green: a rename declared in contract-notes.md', 0, (sb) => {
  syncBase(sb); sb.put('docs/phase-01_mvp/02_specs/contract-notes.md', '# Contract notes\n\n- Renamed: RoomDto → RoomView\n');
  sb.put(CTRL, CTRL_V1.replace(/RoomDto/g, 'RoomView')); return node(sb, 'checks/check-sync.mjs');
});
test('sync red: the same rename, not declared', 1, (sb) => { syncBase(sb); sb.put(CTRL, CTRL_V1.replace(/RoomDto/g, 'RoomView')); return node(sb, 'checks/check-sync.mjs'); });
test('sync green: a changed signature of the same method (the operation gained a parameter)', 0, (sb) => { syncBase(sb); sb.edit(CTRL, 'listRooms(String q)', 'listRooms(String q, Integer page)'); return node(sb, 'checks/check-sync.mjs'); });
test('sync red: code deleted during the sync', 1, (sb) => { syncBase(sb); sb.edit(CTRL, '        RoomDto dto = mapper.toDto(service.all(q));\n', ''); return node(sb, 'checks/check-sync.mjs'); });
test('sync green: the marker class from the template may be added', 0, (sb) => {
  syncBase(sb); sb.put('backend/src/main/java/com/oracul/app/common/NotImplementedException.java', fs.readFileSync(path.join(ENGINE, 'templates/app/backend/src/main/java/com/oracul/app/common/NotImplementedException.java'), 'utf8'));
  return node(sb, 'checks/check-sync.mjs');
});
test('sync red (release): a marker is left in production code', 1, (sb) => { sb.put(CTRL, CTRL_V1.replace(/}\n$/, STUB)); return node(sb, 'checks/check-sync.mjs', ['--release']); },
  (sb, r) => /sync markers left/.test(r.out) || r.out);
test('sync green (release): no marker left', 0, (sb) => { sb.put(CTRL, CTRL_V1); return node(sb, 'checks/check-sync.mjs', ['--release']); });
test('artifacts red: release with a sync marker left', 1, (sb) => {
  sb.put('../../state/apps/fixture/last-run.json', JSON.stringify({ layers: { backend: { exit: 0 }, frontend: { exit: 0 } } }));
  node(sb, 'checks/gen-traceability.mjs'); sb.put(CTRL, CTRL_V1.replace(/}\n$/, STUB));
  return node(sb, 'checks/check-artifacts.mjs', ['--step', '05_release']);
}, (sb, r) => /noSyncMarkers/.test(r.out) || r.out);
// F4: a field that lost `required` moves from the generated constructor to its fluent setter (slice 03, FR-45)
const SUMMARY = (req) => `components:\n  schemas:\n    RecentRunSummary:\n      type: object\n      required: [${req}]\n      properties:\n        id:\n          type: string\n        headline:\n          type: string\n`;
const MAPPER = 'backend/src/main/java/com/oracul/app/runs/RunMapper.java';
const mapperWith = (body) => `package com.oracul.app.runs;\n\nclass RunMapper {\n    RecentRunSummary toSummary(Run run) {\n${body}\n    }\n}\n`;
const moveBase = (sb) => { sb.put('api/openapi.yaml', sb.read('api/openapi.yaml') + SUMMARY('id, headline')); sb.put(MAPPER, mapperWith('        return new RecentRunSummary(run.id(), run.headline());')); gitApp(sb); };
test('sync green: required → optional — constructor argument moved to the setter', 0, (sb) => {
  moveBase(sb); sb.edit('api/openapi.yaml', 'required: [id, headline]', 'required: [id]');
  sb.put(MAPPER, mapperWith('        return new RecentRunSummary(run.id()).headline(run.headline());'));
  return node(sb, 'checks/check-sync.mjs');
});
test('sync green: …also when the setter is on the next line', 0, (sb) => {
  moveBase(sb); sb.edit('api/openapi.yaml', 'required: [id, headline]', 'required: [id]');
  sb.put(MAPPER, mapperWith('        return new RecentRunSummary(run.id())\n            .headline(run.headline());'));
  return node(sb, 'checks/check-sync.mjs');
});
test('sync red: the same move without a contract change', 1, (sb) => { moveBase(sb); sb.put(MAPPER, mapperWith('        return new RecentRunSummary(run.id()).headline(run.headline());')); return node(sb, 'checks/check-sync.mjs'); });
test('sync red: the setter gets a different value than the removed argument', 1, (sb) => {
  moveBase(sb); sb.edit('api/openapi.yaml', 'required: [id, headline]', 'required: [id]');
  sb.put(MAPPER, mapperWith('        return new RecentRunSummary(run.id()).headline("n/a");')); return node(sb, 'checks/check-sync.mjs');
});
test('sync red: a setter for a field that is still required', 1, (sb) => {
  moveBase(sb); sb.edit('api/openapi.yaml', 'required: [id, headline]', 'required: [headline]');
  sb.put(MAPPER, mapperWith('        return new RecentRunSummary(run.id()).headline(run.headline());')); return node(sb, 'checks/check-sync.mjs');
});
test('state green: set subStep sync', 0, (sb) => node(sb, 'bin/state.mjs', ['set', 'subStep', 'sync']));
test('subagent-stop red: a builder leaves behaviour in the sync', 2, (sb) => {
  syncBase(sb); addToCtrl(sb, STUB.replace('throw new NotImplementedException();', 'return null;'));
  sb.state({ step: '04_build', subStep: 'sync', slice: '01_rooms' });
  return hook(sb, 'subagent-stop', { agent_type: 'oracul:backend-builder' });
}, (sb, r) => /return null;/.test(r.out) || r.out);
test('subagent-stop green: a clean sync', 0, (sb) => { syncBase(sb); addToCtrl(sb, STUB); sb.state({ step: '04_build', subStep: 'sync', slice: '01_rooms' }); return hook(sb, 'subagent-stop', { agent_type: 'oracul:backend-builder' }); });

// ---------------- D2: interventions log, delay tags, factory-issue backlog
const NOTES = (sb) => path.join(sb.stateDir, 'apps/fixture/notes.jsonl');
const ISSUES = (sb) => path.join(sb.stateDir, 'apps/fixture/factory-issues.jsonl');
test('notes green: a tagged note is logged with slice and subStep', 0, (sb) => { sb.state({ slice: '01_rooms', subStep: 'green' }); return node(sb, 'bin/state.mjs', ['note', 'ran the tester from the main session after a sync stop', '--tag', 'factory-false-positive']); },
  (sb) => { const r = JSON.parse(fs.readFileSync(NOTES(sb), 'utf8').trim()); return (r.tag === 'factory-false-positive' && r.slice === '01_rooms' && r.subStep === 'green' && !fs.existsSync(ISSUES(sb))) || JSON.stringify(r); });
test('notes red: an unknown delay class is refused', 1, (sb) => node(sb, 'bin/state.mjs', ['note', 'x', '--tag', 'bad-luck']), (sb) => !fs.existsSync(NOTES(sb)) || 'logged anyway');
test('notes green: --issue also lands in the factory-issue backlog', 0, (sb) => node(sb, 'bin/state.mjs', ['note', 'verify --related built an invalid Gradle command', '--tag', 'factory-false-positive', '--issue']),
  (sb) => (fs.existsSync(ISSUES(sb)) && /invalid Gradle command/.test(fs.readFileSync(ISSUES(sb), 'utf8'))) || 'no issue');
test('notes green: a stop text with quotes, $ and backticks survives the shell', 0, (sb) => {
  const text = 'STOPPED: "quoted" $HOME `cmd` \\ back';
  const esc = `"${text.replace(/["\\$`]/g, '\\$&')}"`;
  const x = spawnSync('bash', ['-c', `node "${path.join(ENGINE, 'bin/state.mjs')}" note ${esc} --tag infra`], { env: sb.env, encoding: 'utf8' });
  const r = JSON.parse(fs.readFileSync(NOTES(sb), 'utf8').trim());
  return { code: x.status === 0 && r.text === text ? 0 : 1, out: `${x.stderr} ${r.text}` };
});

// ---------------- G7: shell syntax in docs — seconds, before any expensive gate
const docsCheck = (sb, files) => node(sb, 'checks/check-docs.mjs', ['--files', files]);
test('docs red: a README shell block that does not parse', 1, (sb) => { sb.put('README.md', '# Run\n\n```bash\necho "unclosed\n```\n'); return docsCheck(sb, 'README.md'); },
  (sb, r) => /README\.md:3: bash -n/.test(r.out) || r.out);
test('docs red: a .sh script that does not parse', 1, (sb) => { sb.put('scripts/run.sh', 'if true; then\n  echo x\n'); return docsCheck(sb, 'scripts/run.sh'); });
test('docs green: valid shell blocks (incl. a subshell) parse', 0, (sb) => { sb.put('README.md', '```sh\n(cd backend && ./gradlew test)\n```\n\n```zsh\nfor f in *.md; do echo $f; done\n```\n'); return docsCheck(sb, 'README.md'); },
  (sb, r) => /2 shell block/.test(r.out) || r.out);
test('docs green: no shell blocks → PASS', 0, (sb) => { sb.put('README.md', '# Title\n\n```json\n{"a": 1}\n```\n'); return docsCheck(sb, 'README.md'); });

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

// A11: no improvised E2E — every way of starting Playwright directly, and direct stack changes, in every subStep
const PW_FORMS = [
  'npx playwright test', 'npx --yes playwright@1.50.0 test x.spec.ts', 'pnpx playwright test', 'bunx playwright test',
  'yarn playwright test', 'pnpm exec playwright test', 'pnpm playwright test --grep FR-38', 'npm exec -- playwright test', 'npm x playwright test',
  './node_modules/.bin/playwright test', 'cd apps/fixture/e2e && node_modules/.bin/playwright test --reporter=list --output=/tmp/x',
  'node apps/fixture/e2e/node_modules/@playwright/test/cli.js test', 'node apps/fixture/e2e/node_modules/playwright/cli.js test --project=chromium',
  'cd apps/fixture/e2e && npx playwright test --reporter=list --output=test-results-mine',
];
for (const sub of ['none', 'test-fix', 'green']) {
  for (const cmd of PW_FORMS) test(`guard red: ${sub} runs Playwright directly — \`${cmd}\``, 2, (sb) => bash(sb, sub, cmd));
  test(`guard red: ${sub} changes the stack directly — \`docker compose up -d\``, 2, (sb) => bash(sb, sub, 'docker compose up -d'));
}
for (const [sub, cmd] of [
  ['none', 'yarn add -D playwright'], ['none', 'cd apps/fixture/e2e && npm install'], ['none', 'docker compose logs --tail 50'],
  ['none', 'cat apps/fixture/e2e/playwright.config.ts'], ['none', 'npx playwright install chromium'], ['e2e', `node ${STACK} e2e --detach --focus-slice 01_rooms`],
]) test(`guard green: ${sub} runs \`${cmd.replace(ENGINE, '<engine>')}\``, 0, (sb) => bash(sb, sub, cmd));
test('guard green: the refusal tells the agent to report and stop, not to improvise', 2, (sb) => bash(sb, 'none', 'npx playwright test'),
  (sb, r) => (/report its reason and stop/.test(r.out) && /never run Playwright or docker compose yourself/.test(r.out)) || r.out);
test('stack green: a refused scratch run names the migration and forbids running Playwright yourself', 1, (sb) => node(sb, 'bin/stack.mjs', ['e2e', '--scratch', '--grep', 'rooms.spec.ts', '--dry-run']),
  (sb, r) => (/migration pending/.test(r.out) && /Do not run Playwright yourself/.test(r.out)) || r.out);

test('guard green: SYNC edits production code', 0, (sb) => { sb.state({ subStep: 'sync' }); return hook(sb, 'guard-edits', W(sb.p(CTRL))); });
test('guard red: SYNC edits a test', 2, (sb) => { sb.state({ subStep: 'sync' }); return hook(sb, 'guard-edits', W(sb.p('backend/src/test/java/com/oracul/app/rooms/RoomsApiIT.java'))); });
test('guard red: SYNC edits the contract', 2, (sb) => { sb.state({ subStep: 'sync' }); return hook(sb, 'guard-edits', W(sb.p('api/openapi.yaml'))); });
test('guard red: SYNC runs the stack', 2, (sb) => bash(sb, 'sync', `node ${STACK} up`));

test('guard red: GREEN changes the stack modes', 2, (sb) => { sb.state({ subStep: 'green' }); return hook(sb, 'guard-edits', W(sb.p('.oracul/stack.json'))); });
test('guard green: the analyst writes the stack modes in the spec step', 0, (sb) => { sb.state({ subStep: 'spec' }); return hook(sb, 'guard-edits', W(sb.p('.oracul/stack.json'))); });
test('guard green: a builder adds an env var to docker-compose.yml (app config)', 0, (sb) => { sb.state({ subStep: 'green' }); return hook(sb, 'guard-edits', W(sb.p('docker-compose.yml'))); });

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
const JUNIT_PROPS = path.join(ENGINE, 'templates/app/backend/src/test/resources/junit-platform.properties');
const hasTestTimeout = (text) => /^\s*junit\.jupiter\.execution\.timeout\.default\s*=\s*\d+\s*s\s*$/m.test(text || '');
test('template green: backend tests have a default per-test timeout', 0, () => ({ code: fs.existsSync(JUNIT_PROPS) && hasTestTimeout(fs.readFileSync(JUNIT_PROPS, 'utf8')) ? 0 : 1, out: '' }));
test('template red: properties without the timeout line are reported', 1, () => ({ code: hasTestTimeout('junit.jupiter.execution.parallel.enabled = true\n# junit.jupiter.execution.timeout.default = 120 s\n') ? 0 : 1, out: '' }));
// B1: retry plugin, small build context, cached Gradle layer with production code only
const tpl = (rel) => fs.readFileSync(path.join(ENGINE, 'templates/app', rel), 'utf8');
const hasRetry = (t) => /id\("org\.gradle\.test-retry"\) version "\{\{TEST_RETRY_VERSION\}\}"/.test(t) && /retry \{\s*maxRetries\.set\(1\)\s*failOnPassedAfterRetry\.set\(false\)\s*\}/.test(t);
const cachedDockerfile = (t) => /RUN --mount=type=cache,target=\/root\/\.gradle \.\/gradlew bootJar/.test(t) && /COPY backend\/src\/main \.\/src\/main/.test(t) && !/^COPY backend \.\/backend$/m.test(t) && /^# syntax=docker\/dockerfile:1/.test(t);
const IGNORE_NEEDS = ['**/node_modules', 'backend/build', 'backend/src/test', 'frontend/src/**/*.spec.ts', 'e2e', 'docs', '.git'];
const ignoresAll = (t) => IGNORE_NEEDS.every((x) => t.split('\n').map((l) => l.trim()).includes(x));
test('template green: backend build retries a failed test once (FLAKY, not blocking)', 0, () => ({ code: hasRetry(tpl('backend/build.gradle.kts')) ? 0 : 1, out: '' }));
test('template red: a build file without the retry block is reported', 1, () => ({ code: hasRetry(tpl('backend/build.gradle.kts').replace(/retry \{[\s\S]*?\n    \}/, '')) ? 0 : 1, out: '' }));
test('template green: backend Dockerfile caches Gradle and copies production code only', 0, () => ({ code: cachedDockerfile(tpl('backend/Dockerfile')) ? 0 : 1, out: '' }));
test('template red: the old Dockerfile (whole backend, no cache) is reported', 1, () => ({ code: cachedDockerfile('FROM x\nCOPY api ./api\nCOPY backend ./backend\nRUN ./gradlew bootJar --no-daemon -q\n') ? 0 : 1, out: '' }));
test('template green: .dockerignore keeps tests, specs, docs, e2e and build output out of the images', 0, () => ({ code: ignoresAll(tpl('dockerignore')) ? 0 : 1, out: '' }));
test('template red: an ignore file without backend/src/test is reported', 1, () => ({ code: ignoresAll(tpl('dockerignore').replace('backend/src/test\n', '')) ? 0 : 1, out: '' }));
test('template green: scaffold writes .dockerignore and resolves the retry plugin version', 0, () => {
  const sc = fs.readFileSync(path.join(ENGINE, 'bin/scaffold.mjs'), 'utf8');
  return { code: /'\.dockerignore'\), readText\(path\.join\(T, 'app', 'dockerignore'\)\)/.test(sc) && /TEST_RETRY_VERSION: latestGradlePlugin\('org\.gradle\.test-retry'/.test(sc) ? 0 : 1, out: '' };
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
  const many = { suites: [{ file: 'a.spec.ts', specs: Array.from({ length: 12 }, (_, i) => ({ title: `t${i}`, file: 'a.spec.ts', tests: [{ status: 'unexpected', results: [{ error: { message: Array.from({ length: 30 }, (_, j) => `t${i} line ${j}`).join('\n') } }] }] })) }] }; // distinct errors (identical ones are grouped)
  const lines = failureBlock(many, '/app').split('\n');
  return { code: lines.length <= 70 && lines.some((l) => /2 more failure/.test(l)) ? 0 : 1, out: `${lines.length} lines` };
});

const pwFail = (file, title, message) => ({ title, file, tests: [{ status: 'unexpected', projectName: 'chromium', results: [{ error: { message } }] }] });
test('failure block green: 12 identical failures + 1 different → 2 groups, each test still named', 0, () => {
  const same = "Error: expect(locator).toHaveText(expected) failed\nLocator:  getByTestId('chatgpt-status')\nExpected: \"ChatGPT connected\"";
  const rep = { suites: [{ file: 'a.spec.ts', specs: [...Array.from({ length: 12 }, (_, i) => pwFail(`s${i}.spec.ts`, `t${i}`, same)), pwFail('m.spec.ts', '360 px is mobile', 'Expected: <= 360\nReceived: 371')] }] };
  const b = failureBlock(rep, '/app');
  const ok = /E2E FAILURES \(13 in 2 groups\)/.test(b) && /✘ 12 tests, same error:/.test(b) && /· s0\.spec\.ts › t0/.test(b) && /… 6 more/.test(b)
    && (b.match(/chatgpt-status/g) || []).length === 1 && /✘ m\.spec\.ts › 360 px is mobile/.test(b) && b.split('\n').length <= 70;
  return { code: ok ? 0 : 1, out: b };
});
test('failure block red: different errors are not merged', 1, () => {
  const rep = { suites: [{ file: 'a.spec.ts', specs: [pwFail('a.spec.ts', 'one', 'Error: A'), pwFail('b.spec.ts', 'two', 'Error: B')] }] };
  return { code: /same error/.test(failureBlock(rep, '/app')) ? 0 : 1, out: '' };
});

// detached official E2E (stack.mjs e2e --detach / e2e-wait) with a fake Playwright — no Docker
const fakePw = (sb, ms, code) => { sb.env.ORACUL_E2E_CMD = JSON.stringify(['node', '-e', `setTimeout(() => { console.log('fake playwright'); process.exit(${code}); }, ${ms})`]); };
const RUNSTATUS = (sb) => path.join(sb.stateDir, 'apps/fixture/e2e-run.json');
const pause = (ms) => spawnSync('node', ['-e', `setTimeout(() => {}, ${ms})`]);
test('stack green: detached run — wait says 75 while running, holds the lock, then 0 with E2E PASS and releases', 0, (sb) => {
  fakePw(sb, 2500, 0);
  const d = node(sb, 'bin/stack.mjs', ['e2e', '--detach']);
  const w1 = node(sb, 'bin/stack.mjs', ['e2e-wait', '--max', '0']);
  const busy = node(sb, 'bin/stack.mjs', ['up', '--lock-wait', '0', '--dry-run']);
  const w2 = node(sb, 'bin/stack.mjs', ['e2e-wait', '--max', '30']);
  const ok = d.code === 0 && /E2E STARTED/.test(d.out) && w1.code === 75 && /E2E STILL RUNNING/.test(w1.out) && busy.code === 3
    && w2.code === 0 && /E2E PASS/.test(w2.out) && !fs.existsSync(LOCK(sb));
  return { code: ok ? 0 : 1, out: [d, w1, busy, w2].map((r) => `[${r.code}] ${r.out.trim().slice(-200)}`).join('\n') };
});
test('stack red: detached run that fails → e2e-wait exit 1 with E2E FAIL', 1, (sb) => {
  fakePw(sb, 300, 1);
  const d = node(sb, 'bin/stack.mjs', ['e2e', '--detach']);
  const w = node(sb, 'bin/stack.mjs', ['e2e-wait', '--max', '30']);
  return { code: d.code === 0 && /E2E FAIL/.test(w.out) ? w.code : 'bad', out: d.out + w.out };
});
test('stack red: worker killed → e2e-wait exit 4 E2E WORKER LOST', 4, (sb) => {
  fakePw(sb, 30000, 0);
  const d = node(sb, 'bin/stack.mjs', ['e2e', '--detach']);
  const pid = JSON.parse(fs.readFileSync(RUNSTATUS(sb), 'utf8')).pid;
  process.kill(pid, 'SIGKILL'); pause(300);
  const w = node(sb, 'bin/stack.mjs', ['e2e-wait', '--max', '5']);
  return { code: d.code === 0 && /E2E WORKER LOST/.test(w.out) ? w.code : 'bad', out: d.out + w.out };
});
test('stack red: detach while another stack operation holds the lock → exit 3', 3, (sb) => {
  fakePw(sb, 300, 0); putLock(sb, process.pid);
  const d = node(sb, 'bin/stack.mjs', ['e2e', '--detach', '--lock-wait', '0']);
  return { code: d.code, out: d.out };
});
test('stack red: e2e-wait without a run → exit 1', 1, (sb) => node(sb, 'bin/stack.mjs', ['e2e-wait', '--max', '0']));
test('stack red: --detach with --scratch is refused', 1, (sb) => { sb.put('e2e/playwright.config.ts', TEMPLATE_PW); return node(sb, 'bin/stack.mjs', ['e2e', '--detach', '--scratch', '--grep', 'x']); });

// ---------------- focus E2E + full-run record + freshness (A6)
const E2ELAST = (sb) => path.join(sb.stateDir, 'apps/fixture/e2e-last.json');
const officialRun = (sb, code = 0) => { sb.put('e2e/playwright.config.ts', TEMPLATE_PW); fakePw(sb, 50, code); return node(sb, 'bin/stack.mjs', ['e2e', '--no-up']); };
test('focus green: related E2E specs = slice-tagged + superseded + last failures, nothing unrelated', 0, (sb) => {
  sb.put('e2e/tests/other.spec.ts', '// unrelated');
  sb.put('e2e/tests/old-flow.spec.ts', '// superseded');
  sb.put('e2e/tests/broke.spec.ts', '// failed last time');
  sb.edit(SPEC, '- Changes earlier behaviour: none', '- Changes earlier behaviour: list → grid (tests: e2e/tests/old-flow.spec.ts)');
  sb.put('e2e/report-focus/results.json', JSON.stringify({ suites: [{ file: 'broke.spec.ts', specs: [{ title: 't', file: 'broke.spec.ts', tests: [{ status: 'unexpected', results: [{ error: { message: 'x' } }] }] }] }] }));
  const f = e2eFocus({ appDir: sb.appDir, phaseDir: sb.doc(''), slice: '01_rooms' });
  return { code: f.join(' ') === 'broke.spec.ts old-flow.spec.ts rooms.spec.ts' ? 0 : 1, out: f.join(' ') };
});
test('focus green: dry run scopes Playwright to the focus specs and uses the focus report dirs', 0, (sb) => { sb.put('e2e/playwright.config.ts', TEMPLATE_PW); return node(sb, 'bin/stack.mjs', ['e2e', '--focus-slice', '01_rooms', '--dry-run']); },
  (sb, r) => (/FOCUS 01_rooms: rooms\.spec\.ts/.test(r.out) && /npx playwright test rooms\.spec\.ts/.test(r.out) && /E2E_REPORT_DIR=report-focus/.test(r.out) && /E2E_OUTPUT_DIR=test-results-focus/.test(r.out)) || r.out);
test('focus red: an old config without separate report dirs → exit 5 FOCUS UNSUPPORTED (run the full E2E)', 5, (sb) => node(sb, 'bin/stack.mjs', ['e2e', '--focus-slice', '01_rooms', '--dry-run']),
  (sb, r) => (/FOCUS UNSUPPORTED/.test(r.out) && /never run Playwright yourself/.test(r.out) && !fs.existsSync(LOCK(sb))) || r.out);
test('focus red: nothing to focus on → exit 6 FOCUS EMPTY', 6, (sb) => { sb.put('e2e/playwright.config.ts', TEMPLATE_PW); return node(sb, 'bin/stack.mjs', ['e2e', '--focus-slice', '02_search', '--dry-run']); });
test('focus red: --scratch with --focus-slice is refused', 1, (sb) => { sb.put('e2e/playwright.config.ts', TEMPLATE_PW); return node(sb, 'bin/stack.mjs', ['e2e', '--scratch', '--grep', 'x', '--focus-slice', '01_rooms', '--dry-run']); });
test('focus env green: never points at official output', 0, (sb) => {
  const p = scratchEnvProblems(e2eEnv({ appDir: sb.appDir, phaseDir: sb.doc(''), kind: 'focus' }), sb.appDir);
  return { code: p.length ? 1 : 0, out: p.join('\n') };
});
test('e2e record green: an official full run records its hash; check-e2e-fresh passes on the same code', 0, (sb) => {
  const r = officialRun(sb);
  if (r.code) return r;
  return node(sb, 'checks/check-e2e-fresh.mjs');
}, (sb) => (JSON.parse(fs.readFileSync(E2ELAST(sb), 'utf8')).code === 0) || 'no record');
test('e2e record green: a focus run writes no full-run record', 0, (sb) => { sb.put('e2e/playwright.config.ts', TEMPLATE_PW); fakePw(sb, 50, 0); return node(sb, 'bin/stack.mjs', ['e2e', '--no-up', '--focus-slice', '01_rooms']); },
  (sb) => !fs.existsSync(E2ELAST(sb)) || 'focus run wrote e2e-last.json');
test('e2e fresh red: production code changed after the full run', 1, (sb) => { officialRun(sb); sb.put('backend/src/main/java/com/oracul/app/New.java', 'class New {}'); return node(sb, 'checks/check-e2e-fresh.mjs'); });
test('e2e fresh red: an E2E spec changed after the full run', 1, (sb) => { officialRun(sb); sb.put('e2e/tests/rooms.spec.ts', '// @trace FR-1\n// changed'); return node(sb, 'checks/check-e2e-fresh.mjs'); });
test('e2e fresh green: docs or a backend test changed after the full run (not in the images)', 0, (sb) => {
  officialRun(sb); sb.put('docs/phase-01_mvp/notes.md', 'x'); sb.put('backend/src/test/java/com/oracul/app/X.java', 'class X {}');
  return node(sb, 'checks/check-e2e-fresh.mjs');
});
test('e2e fresh red: the last full run failed', 1, (sb) => { officialRun(sb, 1); return node(sb, 'checks/check-e2e-fresh.mjs'); });
test('e2e fresh red: no full run recorded', 1, (sb) => node(sb, 'checks/check-e2e-fresh.mjs'));
test('e2e fresh green: no record + --allow-missing (app built before the record) → WARN', 0, (sb) => node(sb, 'checks/check-e2e-fresh.mjs', ['--allow-missing']), (sb, r) => /WARN/.test(r.out) || r.out);

// ---------------- Docker rebuild only when image inputs changed (A9)
const STACKHASH = (sb) => path.join(sb.stateDir, 'apps/fixture/stack-hash.json');
const builtNow = (sb) => write(STACKHASH(sb), JSON.stringify({ hash: imageInputsHash(sb.appDir), at: new Date().toISOString() }));
const upPlan = (sb) => node(sb, 'bin/stack.mjs', ['up', '--dry-run']);
test('rebuild red: no record of the built images → --build', 0, (sb) => upPlan(sb), (sb, r) => /up -d --build \(no record of the built images\)/.test(r.out) || r.out);
test('rebuild green: same image inputs → no rebuild', 0, (sb) => { builtNow(sb); return upPlan(sb); }, (sb, r) => (/up -d \(images current — no rebuild\)/.test(r.out) && !/--build/.test(r.out)) || r.out);
test('rebuild red: production code changed → --build', 0, (sb) => { builtNow(sb); sb.put('backend/src/main/java/com/oracul/app/New.java', 'class New {}'); return upPlan(sb); },
  (sb, r) => /--build \(image inputs changed\)/.test(r.out) || r.out);
test('rebuild green: only tests, specs and docs changed → no rebuild', 0, (sb) => {
  builtNow(sb);
  sb.put('backend/src/test/java/com/oracul/app/X.java', 'class X {}'); sb.put('frontend/src/app/x.spec.ts', '//'); sb.put('e2e/tests/x.spec.ts', '//'); sb.put('docs/n.md', 'x');
  return upPlan(sb);
}, (sb, r) => /images current — no rebuild/.test(r.out) || r.out);
test('rebuild red: an unknown new file at the app root counts (fail-safe) → --build', 0, (sb) => { builtNow(sb); sb.put('nginx-extra.conf', 'x'); return upPlan(sb); },
  (sb, r) => /--build \(image inputs changed\)/.test(r.out) || r.out);
// G2: docs never trigger a rebuild; .dockerignore decides what reaches an image (slice 03: a README line cost ~45 min)
test('rebuild green: a README change does not change the image inputs', 0, (sb) => { builtNow(sb); sb.put('README.md', '# changed\n'); sb.put('backend/NOTES.md', 'x'); return upPlan(sb); },
  (sb, r) => /images current — no rebuild/.test(r.out) || r.out);
test('rebuild green: a path the app\'s .dockerignore excludes does not count', 0, (sb) => { sb.put('.dockerignore', 'notes/\n'); builtNow(sb); sb.put('notes/todo.txt', 'x'); return upPlan(sb); },
  (sb, r) => /images current — no rebuild/.test(r.out) || r.out);
test('rebuild red: a negated .dockerignore pattern is honoured (that file counts)', 0, (sb) => { sb.put('.dockerignore', 'config/*\n!config/keep.yml\n'); builtNow(sb); sb.put('config/keep.yml', 'x'); return upPlan(sb); },
  (sb, r) => /--build \(image inputs changed\)/.test(r.out) || r.out);
test('rebuild red: an unsupported .dockerignore pattern excludes nothing (fail-safe)', 0, (sb) => { sb.put('.dockerignore', 'conf[ig]/\n'); builtNow(sb); sb.put('config/x.yml', 'x'); return upPlan(sb); },
  (sb, r) => /--build \(image inputs changed\)/.test(r.out) || r.out);
test('dockerignore green: matcher semantics (dir, *.ext, **/x, last match wins)', 0, () => {
  const m = dockerignoreMatcher('# c\n**/node_modules\nbuild/\n*.log\ndocs\n!docs/keep.txt\n');
  const ok = m('frontend/node_modules/a.js') && m('build/x/y') && m('a.log') && !m('src/a.log') && m('docs/a.md') && !m('docs/keep.txt') && !m('src/main.ts');
  return { code: ok ? 0 : 1, out: '' };
});
test('template green: .dockerignore leaves Markdown out of the images', 0, () => ({ code: /^\*\*\/\*\.md$/m.test(fs.readFileSync(path.join(ENGINE, 'templates/app/dockerignore'), 'utf8')) ? 0 : 1, out: '' }));
test('migrate green: an existing .dockerignore gets **/*.md once', 0, (sb) => { sb.put('.dockerignore', 'node_modules\n'); migrate(sb, ['--speed']); migrate(sb, ['--speed']); return { code: (sb.read('.dockerignore').match(/\*\*\/\*\.md/g) || []).length === 1 ? 0 : 1, out: sb.read('.dockerignore') }; });
test('rebuild green: --build forces a rebuild', 0, (sb) => { builtNow(sb); return node(sb, 'bin/stack.mjs', ['up', '--dry-run', '--build']); }, (sb, r) => /--build \(--build given\)/.test(r.out) || r.out);

// ---------------- WP-I: stack modes the app declares (.oracul/stack.json)
const STACKCFG = { project: 'fixture', modes: { e2e: { files: ['docker-compose.yml', 'docker-compose.e2e.yml'], profiles: ['stub'] }, run: { files: ['docker-compose.yml'], profiles: ['real'] } } };
const withModes = (sb, cfg = STACKCFG) => { sb.put('docker-compose.e2e.yml', 'services: {}\n'); sb.put('.oracul/stack.json', JSON.stringify(cfg)); };
test('stack modes green: e2e mode = its files and profiles; down = every mode + --remove-orphans', 0, () => {
  const e = composeArgs(STACKCFG, 'up', 'e2e').join(' '), d = composeArgs(STACKCFG, 'down').join(' ');
  return { code: e === '-p fixture -f docker-compose.yml -f docker-compose.e2e.yml --profile stub' && d === '-p fixture -f docker-compose.yml -f docker-compose.e2e.yml --profile stub --profile real' ? 0 : 1, out: `${e} | ${d}` };
});
test('stack modes green: up (default mode e2e) uses the e2e files and profile', 0, (sb) => { withModes(sb); return node(sb, 'bin/stack.mjs', ['up', '--dry-run']); },
  (sb, r) => /docker compose -p fixture -f docker-compose\.yml -f docker-compose\.e2e\.yml --profile stub up -d --build/.test(r.out) || r.out);
test('stack modes green: up --mode run uses the run files', 0, (sb) => { withModes(sb); return node(sb, 'bin/stack.mjs', ['up', '--mode', 'run', '--dry-run']); },
  (sb, r) => (/docker compose -p fixture -f docker-compose\.yml --profile real up -d/.test(r.out) && !/e2e\.yml/.test(r.out)) || r.out);
test('stack modes green: down covers every mode and removes orphans', 0, (sb) => { withModes(sb); return node(sb, 'bin/stack.mjs', ['down', '--dry-run']); },
  (sb, r) => /docker compose -p fixture -f docker-compose\.yml -f docker-compose\.e2e\.yml --profile stub --profile real down --remove-orphans/.test(r.out) || r.out);
test('stack modes green: no config, no extra files → exactly today\'s plain command', 0, (sb) => node(sb, 'bin/stack.mjs', ['up', '--dry-run']),
  (sb, r) => /^DRY RUN \(lock held\): docker compose up -d --build \(no record of the built images\)$/m.test(r.out) || r.out);
test('stack modes red: an extra compose file without declared modes → up refused (never guess the E2E stack)', 1, (sb) => { sb.put('docker-compose.e2e.yml', 'services: {}\n'); return node(sb, 'bin/stack.mjs', ['up', '--dry-run']); },
  (sb, r) => (/extra compose file\(s\) docker-compose\.e2e\.yml but no \.oracul\/stack\.json/.test(r.out) && !fs.existsSync(LOCK(sb))) || r.out);
test('stack modes red: …and the official E2E is refused too', 1, (sb) => { sb.put('docker-compose.override.yml', 'services: {}\n'); return node(sb, 'bin/stack.mjs', ['e2e', '--dry-run']); });
test('stack modes red: a mode names a compose file that does not exist', 1, (sb) => { sb.put('.oracul/stack.json', JSON.stringify(STACKCFG)); return node(sb, 'bin/stack.mjs', ['up', '--dry-run']); },
  (sb, r) => /docker-compose\.e2e\.yml does not exist/.test(r.out) || r.out);
test('stack modes red: unknown --mode', 1, (sb) => node(sb, 'bin/stack.mjs', ['up', '--mode', 'prod', '--dry-run']));
test('check-stack green: declared modes', 0, (sb) => { withModes(sb); return node(sb, 'checks/check-stack.mjs'); });
test('check-stack green: plain docker-compose.yml', 0, (sb) => node(sb, 'checks/check-stack.mjs'));
test('check-stack red: extra compose file without modes', 1, (sb) => { sb.put('docker-compose.e2e.yml', 'x'); return node(sb, 'checks/check-stack.mjs'); });
test('check-stack red: config without an e2e mode', 1, (sb) => { withModes(sb, { modes: { run: { files: ['docker-compose.yml'] } } }); return node(sb, 'checks/check-stack.mjs'); });

// ---------------- G1: input groups and the gate ledger
const LEDGER = (sb) => path.join(sb.stateDir, 'apps/fixture/gates.json');
const hashes = (sb) => { const g = filesByGroup(sb.appDir); return { backend: gateHash(sb.appDir, 'backend', g), frontend: gateHash(sb.appDir, 'frontend', g), docs: gateHash(sb.appDir, 'docs', g), rooms: gateHash(sb.appDir, 'e2e:rooms.spec.ts', g) }; };
const changedGates = (before, after) => Object.keys(before).filter((k) => before[k] !== after[k]).sort().join(',');
test('inputs green: file groups (unknown and root files are shared)', 0, () => {
  const ok = groupOf('backend/src/main/A.java') === 'backend' && groupOf('frontend/src/app/x.ts') === 'frontend' && groupOf('e2e/tests/a.spec.ts') === 'e2e'
    && groupOf('README.md') === 'docs' && groupOf('backend/README.md') === 'docs' && groupOf('docs/x.txt') === 'docs' && groupOf('api/openapi.yaml') === 'shared'
    && groupOf('docker-compose.yml') === 'shared' && groupOf('weird.cfg') === 'shared' && groupOf('frontend/src/app/api/x.ts') === null && groupOf('e2e/report/results.json') === null;
  return { code: ok ? 0 : 1, out: '' };
});
test('inputs green: a README change touches only the docs gate', 0, (sb) => { const b = hashes(sb); sb.put('README.md', '# new\n'); return { code: changedGates(b, hashes(sb)) === 'docs' ? 0 : 1, out: changedGates(b, hashes(sb)) }; });
test('inputs green: a backend change → backend gate and every E2E spec (image), not frontend', 0, (sb) => { const b = hashes(sb); sb.put('backend/src/main/java/X.java', 'class X {}'); return { code: changedGates(b, hashes(sb)) === 'backend,rooms' ? 0 : 1, out: changedGates(b, hashes(sb)) }; });
test('inputs red: the contract or an unknown root file → every code gate', 0, (sb) => {
  const b = hashes(sb); sb.put('weird.cfg', 'x'); const c1 = changedGates(b, hashes(sb));
  const b2 = hashes(sb); sb.edit('api/openapi.yaml', 'listRooms', 'listAllRooms'); const c2 = changedGates(b2, hashes(sb));
  return { code: c1 === 'backend,frontend,rooms' && c2 === 'backend,frontend,rooms' ? 0 : 1, out: `${c1} | ${c2}` };
});
test('inputs green: a changed spec touches only its own E2E gate', 0, (sb) => {
  sb.put('e2e/tests/other.spec.ts', '// other'); const g0 = filesByGroup(sb.appDir); const o0 = gateHash(sb.appDir, 'e2e:other.spec.ts', g0); const b = hashes(sb);
  sb.put('e2e/tests/other.spec.ts', '// other, changed');
  return { code: changedGates(b, hashes(sb)) === '' && gateHash(sb.appDir, 'e2e:other.spec.ts') !== o0 ? 0 : 1, out: changedGates(b, hashes(sb)) };
});
test('inputs green: a spec (or test) that reads README depends on it', 0, (sb) => {
  sb.put('e2e/tests/readme.spec.ts', "const t = readFileSync('../README.md', 'utf8');"); sb.put('README.md', 'a');
  const r0 = gateHash(sb.appDir, 'e2e:readme.spec.ts'), b0 = gateHash(sb.appDir, 'backend');
  sb.put('backend/src/test/java/ReadmeTest.java', 'class ReadmeTest { String f = "README.md"; }'); const b1 = gateHash(sb.appDir, 'backend');
  sb.put('README.md', 'b');
  return { code: gateHash(sb.appDir, 'e2e:readme.spec.ts') !== r0 && gateHash(sb.appDir, 'backend') !== b1 && b0 !== b1 ? 0 : 1, out: '' };
});
test('ledger green: a full verify records both layers (full) on the hashes it tested', 1, (sb) => node(sb, 'checks/verify.mjs'), (sb) => {
  const l = JSON.parse(fs.readFileSync(LEDGER(sb), 'utf8')).gates;
  return (l.backend?.full === true && l.backend.hash === gateHash(sb.appDir, 'backend') && !!l.frontend?.result) || JSON.stringify(l);
});
test('ledger red: a related verify never records a gate', 1, (sb) => { sb.state({ slice: '01_rooms', step: '04_build' }); return node(sb, 'checks/verify.mjs', ['--related']); }, (sb) => !fs.existsSync(LEDGER(sb)) || 'related run wrote the ledger');
test('ledger green: an official E2E run records each spec it ran', 0, (sb) => { sb.put('e2e/playwright.config.ts', TEMPLATE_PW); fakePw(sb, 50, 0); return node(sb, 'bin/stack.mjs', ['e2e', '--no-up']); },
  (sb) => { const l = JSON.parse(fs.readFileSync(LEDGER(sb), 'utf8')).gates; return (l['e2e:rooms.spec.ts']?.result === 'pass' && l['e2e:rooms.spec.ts'].hash === gateHash(sb.appDir, 'e2e:rooms.spec.ts')) || JSON.stringify(l); });
test('gates red: nothing recorded → not all green', 1, (sb) => node(sb, 'bin/gates.mjs', ['status']), (sb, r) => /never\s+backend/.test(r.out) || r.out);
test('gates green: every gate recorded on the current inputs → ALL GREEN', 0, (sb) => {
  recordGatesFor(sb, ['backend', 'frontend', 'e2e:rooms.spec.ts']); return node(sb, 'bin/gates.mjs', ['status']);
}, (sb, r) => /ALL 3 GATES GREEN/.test(r.out) || r.out);
test('gates red: a gate green on older inputs is stale', 1, (sb) => { recordGatesFor(sb, ['backend', 'frontend', 'e2e:rooms.spec.ts']); sb.put('frontend/src/app/x.ts', 'x'); return node(sb, 'bin/gates.mjs', ['status']); },
  (sb, r) => /stale\s+frontend .*inputs changed/.test(r.out) || r.out);

// ---------------- G3: incremental verify — a layer green on the current inputs is not run again
const greenNow = (sb, layers = ['backend', 'frontend']) => {
  const l = { gates: Object.fromEntries(layers.map((g) => [g, { hash: gateHash(sb.appDir, g), result: 'pass', full: true, coverage: g === 'backend' ? 80 : 75, at: '2026-10-05T00:00:00Z' }])) };
  write(LEDGER(sb), JSON.stringify(l));
  sb.put('../../state/apps/fixture/last-run.json', JSON.stringify({ layers: { backend: { exit: 0, seconds: 500 }, frontend: { exit: 0, seconds: 10 } } }));
};
test('incremental green: nothing changed → both layers skipped, checks run, GREEN', 0, (sb) => { sb.state({ step: '04_build' }); greenNow(sb); sb.baseline({ backend: 80, frontend: 75 }); return node(sb, 'checks/verify.mjs', ['--incremental']); },
  (sb, r) => (/SKIP\s+backend: green on the current inputs/.test(r.out) && /SKIP\s+frontend: green on the current inputs/.test(r.out) && /== coverage ratchet ==/.test(r.out) && /full run of 2026-10-05T00:00:00Z, inputs unchanged/.test(r.out)
    && JSON.parse(fs.readFileSync(lastRunFile(sb), 'utf8')).layers.backend.reused === true) || r.out);
test('incremental green: a README change still skips both layers', 0, (sb) => { sb.state({ step: '04_build' }); greenNow(sb); sb.baseline({ backend: 80, frontend: 75 }); sb.put('README.md', '# changed'); return node(sb, 'checks/verify.mjs', ['--incremental']); });
test('incremental red: a frontend change runs the frontend (only)', 1, (sb) => { sb.state({ step: '04_build' }); greenNow(sb); sb.put('frontend/src/app/x.ts', 'x'); return node(sb, 'checks/verify.mjs', ['--incremental']); },
  (sb, r) => (/SKIP\s+backend: green/.test(r.out) && /== frontend: npm run test:ci/.test(r.out)) || r.out);
test('incremental red: a shared change runs both layers', 1, (sb) => { sb.state({ step: '04_build' }); greenNow(sb); sb.put('docker-compose.yml', 'services: {}'); return node(sb, 'checks/verify.mjs', ['--incremental']); },
  (sb, r) => (/== backend: \.\/gradlew/.test(r.out) && /== frontend: npm/.test(r.out)) || r.out);
test('coverage green: a layer green on the current inputs uses its full-run coverage, not a partial report', 0, (sb) => { greenNow(sb); sb.baseline({ backend: 79, frontend: 74 }); return node(sb, 'checks/check-coverage.mjs'); },
  (sb, r) => /backend 80\.0% \(full run of/.test(r.out) || r.out);
test('coverage red: a stale gate falls back to the report on disk', 1, (sb) => { greenNow(sb); sb.baseline({ backend: 90, frontend: 74 }); sb.put('backend/src/main/java/X.java', 'class X {}'); return node(sb, 'checks/check-coverage.mjs'); });
test('verify green: --reuse-if-fresh reuses when both layer gates are green on the current inputs', 0, (sb) => { greenNow(sb); touchLater(sb, 'backend/build/test-results/test/TEST-com.oracul.app.rooms.RoomsApiIT.xml'); return reuse(sb); },
  (sb, r) => /reusing the full GREEN verify/.test(r.out) || r.out);
test('verify red: --reuse-if-fresh runs a full verify when a layer gate is stale', 1, (sb) => { greenNow(sb); sb.put('frontend/src/app/x.ts', 'x'); return reuse(sb); },
  (sb, r) => /a layer gate is not green on the current inputs \(frontend\)/.test(r.out) || r.out);

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

// ---------------- WP-Q: model policy — every agent has a model and an effort
const POLICY = { analyst: 'opus/high', reviewer: 'opus/high', tester: 'sonnet/high', 'backend-builder': 'sonnet/medium', 'frontend-builder': 'sonnet/medium', 'qa-documenter': 'sonnet/medium' };
const agentPolicy = (text) => { const m = (text.match(/^model: (\w+)$/m) || [])[1], e = (text.match(/^effort: (\w+)$/m) || [])[1]; return m && e ? `${m}/${e}` : null; };
test('models green: every agent file names the model and effort of the policy', 0, () => {
  const bad = Object.entries(POLICY).filter(([a, want]) => agentPolicy(fs.readFileSync(path.join(ENGINE, 'agents', `${a}.md`), 'utf8')) !== want).map(([a]) => a);
  const extra = fs.readdirSync(path.join(ENGINE, 'agents')).filter((f) => !POLICY[f.replace(/\.md$/, '')]);
  return { code: bad.length || extra.length ? 1 : 0, out: [...bad, ...extra].join(', ') };
});
test('models red: an agent file without effort is reported', 1, () => ({ code: agentPolicy('---\nname: x\nmodel: sonnet\n---\n') ? 0 : 1, out: '' }));

// ---------------- workflows: build-slice stage contract (stub agents, no real commands)
// The command inside a runner prompt: between `<fence>bash` and the same fence (the fence is longer than any backtick
// run in the command).
const runnerCommand = (p) => { const m = p.match(/(`{3,})bash\n([\s\S]*?)\n\1\n/); return m ? m[2] : ''; };
// The verify of the green loop — NOT the close chain's `verify.mjs --reuse-if-fresh`.
const LOOP_VERIFY = /checks\/verify\.mjs"(?! --reuse-if-fresh)/;
async function runWorkflow(file, args, answer, source) {
  const src = (source ?? fs.readFileSync(path.join(ENGINE, 'workflows', file), 'utf8')).replace(/^export const meta/m, 'const meta');
  const AsyncFn = Object.getPrototypeOf(async () => {}).constructor;
  const calls = [];
  // Like a real shell: a gate command ends with `echo "ORACUL_EXIT=$?"`, so its output carries the sentinel — except
  // when the guard refused it, the runner timed out (124), or the stub returns raw output (runner misbehaviour).
  const agent = async (prompt, opts = {}) => {
    calls.push({ prompt, opts });
    const r = await answer(prompt, opts);
    if (r && typeof r.exitCode === 'number' && opts.label?.startsWith('run:') && /ORACUL_EXIT=\$\?/.test(prompt) && !r.raw
      && r.exitCode !== 124 && !/\[oracul guard\]/.test(r.output || '')) return { ...r, output: `${r.output || ''}\nORACUL_EXIT=${r.exitCode}` };
    return r;
  };
  const parallel = async (ts) => Promise.all(ts.map((t) => t().catch(() => null)));
  const fn = new AsyncFn('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget', 'workflow', src);
  return { result: await fn(agent, parallel, null, () => {}, () => {}, args, null, null), calls };
}
const wfArgs = (extra) => ({ engine: ENGINE, root: '/r', app: 'a', appDir: '/r/apps/a', phase: 'phase-01_mvp', phaseDir: '/r/apps/a/docs/phase-01_mvp', slice: '01_rooms', frs: ['FR-1'], ...extra });
// The E2E freshness probe (without --allow-missing) answers "not fresh" by default, so the full E2E runs.
const FRESH_PROBE = /check-e2e-fresh\.mjs"(?! --allow-missing)/;
const ok0 = (p, o) => (o.schema && o.schema.required?.includes('exitCode')
  ? (FRESH_PROBE.test(p) ? { exitCode: 1, output: 'INVALID  no full E2E run recorded' } : { exitCode: 0, output: '{"slice":"01_rooms","decision":"CONTINUE","dependents":[]}' })
  : o.schema ? { summary: '', testProblems: [], open: [], code: '', tests: [] } : 'done');
const asyncCases = [];
let wfStarted = false; // wf() after the run loop would be silently skipped — it throws instead
const wf = (name, expectCode, args, answer, judge) => {
  if (wfStarted) throw new Error(`wf('${name}') registered after the workflow cases ran — move it up`);
  if (!filter || name.includes(filter)) asyncCases.push({ name, expectCode, args, answer, judge });
};
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
wf('workflow green: tester self-check is scoped (--scope slice), capped at 3 runs, stops on causes it cannot fix', 0, wfArgs({ stage: 'red' }), ok0, ({ result, calls }) => {
  const tester = calls.find((c) => c.opts.label?.startsWith('tester: red'));
  return /red-check\.mjs" --slice 01_rooms --scope slice/.test(tester.prompt) && /at most 3 runs/.test(tester.prompt) && /compileJava FAILED/.test(tester.prompt)
    && /FLAKY/.test(tester.prompt) && /Never poll with sleep/.test(tester.prompt) && /--scope slice$/.test(result.next) ? 0 : 1;
});
wf('workflow red: an unscoped tester self-check would be caught', 1, wfArgs({ stage: 'red' }), ok0, ({ calls }) => {
  const tester = calls.find((c) => c.opts.label?.startsWith('tester: red'));
  return /--scope slice/.test(tester.prompt.replace(/--scope slice/g, '')) ? 0 : 1;
});
wf('workflow green: builders loop on the slice tests and run their layer once', 0, wfArgs({ stage: 'green', red: { exitCode: 0, output: '' } }), ok0, ({ calls }) => {
  const be = calls.find((c) => c.opts.label === 'backend: 01_rooms r1');
  const fe = calls.find((c) => c.opts.label === 'frontend: 01_rooms r1');
  const rule = (p) => /run only the slice's tests/.test(p) && /--tests <classes from .*red-evidence\.md/.test(p) && /--include/.test(p) && /whole layer once/.test(p);
  const md = ['backend-builder', 'frontend-builder'].every((a) => /\*\*once\*\*/.test(fs.readFileSync(path.join(ENGINE, 'agents', `${a}.md`), 'utf8')));
  return be && fe && rule(be.prompt) && rule(fe.prompt) && md ? 0 : 1;
});
wf('workflow red: a builder prompt without the related-tests rule would be caught', 1, wfArgs({ stage: 'green', red: { exitCode: 0, output: '' } }), ok0, ({ calls }) => {
  const be = calls.find((c) => c.opts.label === 'backend: 01_rooms r1');
  return /run only the slice's tests/.test(be.prompt.replace("run only the slice's tests", '')) ? 0 : 1;
});
const verifyKinds = (calls) => calls.filter((c) => c.opts.label?.startsWith('run: verify')).map((c) => (/verify\.mjs" --related --slice 01_rooms/.test(c.prompt) ? 'related' : 'full'));
wf('workflow green: round 1 = full verify only; a fix round = related verify, then full verify', 0, wfArgs({ stage: 'green', red: { exitCode: 0, output: '' } }), (() => {
  let n = 0;
  return (p, o) => (/stack\.mjs" e2e-wait/.test(p) && !n++ ? { exitCode: 1, output: 'E2E FAIL' } : ok0(p, o));
})(), ({ result, calls }) => (result.status === 'DONE' && verifyKinds(calls).join(',') === 'full,related,full' ? 0 : 1));
wf('workflow red: related verify RED in a fix round → triaged, no full verify in that round', 1, wfArgs({ stage: 'green', red: { exitCode: 0, output: '' }, maxRounds: 2 }), (() => {
  let n = 0;
  return (p, o) => (/stack\.mjs" e2e-wait/.test(p) && !n++ ? { exitCode: 1, output: 'E2E FAIL' }
    : /verify\.mjs" --related/.test(p) ? { exitCode: 1, output: '==== VERIFY (related tests) RED: backend ====' } : ok0(p, o));
})(), ({ calls }) => (verifyKinds(calls).join(',') === 'full,related' && calls.some((c) => /^triage: verify \(related tests\)/.test(c.opts.label || '')) ? 1 : 0));
const e2eKinds = (calls) => calls.filter((c) => /stack\.mjs" e2e --detach/.test(c.prompt)).map((c) => (/--focus-slice 01_rooms/.test(c.prompt) ? 'focus' : 'full'));
const e2eFailsFirst = (extra = () => null) => { let n = 0; return (p, o) => extra(p, o) || (/stack\.mjs" e2e-wait/.test(p) && !n++ ? { exitCode: 1, output: 'E2E FAIL' } : ok0(p, o)); };
wf('workflow green: round 1 = full E2E; a fix round = focus run, then the full run', 0, wfArgs({ stage: 'green', red: { exitCode: 0, output: '' } }), e2eFailsFirst(),
  ({ result, calls }) => (result.status === 'DONE' && e2eKinds(calls).join(',') === 'full,focus,full' ? 0 : 1));
wf('workflow red: focus run RED → triaged, no full run in that round', 1, wfArgs({ stage: 'green', red: { exitCode: 0, output: '' }, maxRounds: 2 }), (() => {
  let n = 0;
  return (p, o) => (/stack\.mjs" e2e-wait/.test(p) ? (n++ < 2 ? { exitCode: 1, output: 'E2E FAIL' } : { exitCode: 0, output: 'E2E PASS' }) : ok0(p, o));
})(), ({ calls }) => (e2eKinds(calls).join(',') === 'full,focus' && calls.some((c) => /^triage: E2E focus run/.test(c.opts.label || '')) ? 1 : 0));
wf('workflow green: focus unsupported (exit 5) → straight to the full official run', 0, wfArgs({ stage: 'green', red: { exitCode: 0, output: '' } }),
  e2eFailsFirst((p) => (/--focus-slice/.test(p) ? { exitCode: 5, output: 'FOCUS UNSUPPORTED: …' } : null)),
  ({ result, calls }) => (result.status === 'DONE' && e2eKinds(calls).join(',') === 'full,focus,full' && !calls.some((c) => /^triage: E2E focus/.test(c.opts.label || '')) ? 0 : 1));
wf('workflow green: the full run is skipped when check-e2e-fresh says the code was already tested', 0, wfArgs({ stage: 'green', red: { exitCode: 0, output: '' } }),
  (p, o) => (FRESH_PROBE.test(p) ? { exitCode: 0, output: 'PASS the last full E2E run passed on exactly this code' } : ok0(p, o)),
  ({ result, calls }) => (result.status === 'DONE' && e2eKinds(calls).length === 0 ? 0 : 1));
wf('workflow green: close checks the E2E freshness right after the verify reuse', 0, wfArgs({ stage: 'green', red: { exitCode: 0, output: '' } }), ok0, ({ calls }) => {
  const c = calls.find((x) => CLOSE.test(x.prompt));
  const p = c ? runnerCommand(c.prompt) : '';
  const a = p.indexOf('verify.mjs" --reuse-if-fresh'), b = p.indexOf('check-e2e-fresh.mjs" --allow-missing'), d = p.indexOf('check-artifacts.mjs');
  return a >= 0 && b > a && d > b ? 0 : 1;
});
const buildersIn = (calls, r) => calls.filter((c) => new RegExp(`^(backend|frontend): 01_rooms r${r}$`).test(c.opts.label || '')).map((c) => c.opts.label.split(':')[0]).sort().join(',');
const triageSays = (answer) => { let n = 0; return (p, o) => (/stack\.mjs" e2e-wait/.test(p) && !n++ ? { exitCode: 1, output: 'E2E FAIL' } : o.label?.startsWith('triage') ? answer : ok0(p, o)); };
wf('workflow green: triage says backend → only the backend builder runs the fix round', 0, wfArgs({ stage: 'green', red: { exitCode: 0, output: '' } }), triageSays({ code: 'fix the 500', layers: ['backend'], tests: [] }),
  ({ result, calls }) => (result.status === 'DONE' && buildersIn(calls, 1) === 'backend,frontend' && buildersIn(calls, 2) === 'backend' ? 0 : 1));
wf('workflow green: triage unsure (no layers) → both builders', 0, wfArgs({ stage: 'green', red: { exitCode: 0, output: '' } }), triageSays({ code: 'fix it', tests: [] }),
  ({ calls }) => (buildersIn(calls, 2) === 'backend,frontend' ? 0 : 1));
wf('workflow red: a frontend-only fix that started the backend builder would be caught', 1, wfArgs({ stage: 'green', red: { exitCode: 0, output: '' } }), triageSays({ code: 'fix the label', layers: ['frontend'], tests: [] }),
  ({ calls }) => (buildersIn(calls, 2) === 'frontend' ? 1 : 0));
wf('workflow green: review finding on a backend file → only the backend builder', 0, wfArgs({ stage: 'green', red: { exitCode: 0, output: '' } }), (() => {
  let reviews = 0;
  return (p, o) => {
    if (/check-review/.test(p)) return { exitCode: reviews > 1 ? 0 : 1, output: 'INVALID open' };
    if (o.label?.startsWith('reviewer')) { reviews++; return { open: [{ id: 'R1', severity: 'high', dimension: 'correctness', file: 'backend/src/main/java/X.java', problem: 'npe' }] }; }
    return ok0(p, o);
  };
})(), ({ calls }) => (buildersIn(calls, 2) === 'backend' ? 0 : 1));
const reviewOn = (file) => (() => { let reviews = 0; return (p, o) => {
  if (/check-review/.test(p)) return { exitCode: reviews > 1 ? 0 : 1, output: 'INVALID open' };
  if (o.label?.startsWith('reviewer')) { reviews++; return { open: [{ id: 'R1', severity: 'high', dimension: 'correctness', file, problem: 'stub not wired' }] }; }
  return ok0(p, o);
}; })();
wf('workflow green: a finding on a compose file goes to the backend builder (stack wiring owner)', 0, wfArgs({ stage: 'green', red: { exitCode: 0, output: '' } }), reviewOn('docker-compose.e2e.yml'), ({ calls }) => (buildersIn(calls, 2) === 'backend' ? 0 : 1));
wf('workflow green: a finding on frontend/nginx.conf goes to the frontend builder', 0, wfArgs({ stage: 'green', red: { exitCode: 0, output: '' } }), reviewOn('frontend/nginx.conf'), ({ calls }) => (buildersIn(calls, 2) === 'frontend' ? 0 : 1));
wf('workflow green: the triage prompt names the stack wiring owners', 0, wfArgs({ stage: 'green', red: { exitCode: 0, output: '' } }), e2eFailsFirst(), ({ calls }) => {
  const t = calls.find((c) => /^triage/.test(c.opts.label || ''));
  return t && /compose files and stub services are "backend"/.test(t.prompt) && /nginx\.conf routes are "frontend"/.test(t.prompt) ? 0 : 1;
});
wf('workflow green: every round increments the round counter exactly once, with no standalone state call', 0, wfArgs({ stage: 'green', red: { exitCode: 0, output: '' } }), triageSays({ code: '', tests: [{ file: 'e2e/tests/rooms.spec.ts', problem: 'wrong testid' }] }), ({ calls }) => {
  const cmds = calls.filter((c) => c.opts.label?.startsWith('run:')).map((c) => runnerCommand(c.prompt));
  const incs = cmds.filter((c) => /state\.mjs" round \+1/.test(c)).length;
  const standalone = cmds.filter((c) => /^node "[^"]*state\.mjs" (round \+1|set subStep \S+)$/.test(c.trim())).length;
  return incs === 2 && standalone <= 3 ? 0 : 1;
});
// stage red with the contract sync (stub compile results)
const syncAnswer = ({ compiles = [1, 0], guard = [0], unlisted = false, valid = [0] } = {}) => { let c = 0, g = 0, v = 0; return (p, o) => {
  if (/check-contract\.mjs" --validate/.test(p)) { const code = valid[Math.min(v++, valid.length - 1)]; return { exitCode: code, output: code ? 'INVALID  validate: the backend generator rejects api/openapi.yaml — mapping values are not allowed' : 'PASS validate' }; }
  if (/compile-check\.mjs" --stage main/.test(p)) { const code = compiles[Math.min(c++, compiles.length - 1)]; return { exitCode: code, output: code ? 'FAIL     backend main\nCOMPILE ERRORS: 3 (main 3)' : 'COMPILE OK' }; }
  if (/check-sync\.mjs"/.test(p)) { const code = guard[Math.min(g++, guard.length - 1)]; return { exitCode: code, output: `SYNC VIOLATIONS: ${code}` }; }
  if (/--require-listed/.test(p)) return unlisted ? { exitCode: 1, output: 'UNLISTED backend/src/test/java/com/oracul/app/old/OldIT.java — …' } : { exitCode: 0, output: 'COMPILE OK' };
  return ok0(p, o);
}; };
const labelsOf = (calls) => calls.map((c) => c.opts.label || '');
wf('workflow green: stage red — production compiles → no sync, the tester runs', 0, wfArgs({ stage: 'red' }), syncAnswer({ compiles: [0] }), ({ result, calls }) =>
  (result.stage === 'red' && !result.status && !calls.some((c) => /set subStep sync/.test(c.prompt)) && labelsOf(calls).some((l) => /^tester: red/.test(l)) ? 0 : 1));
wf('workflow green: stage red — contract broke the compile → sync builder, check-sync, compile again, then the tester', 0, wfArgs({ stage: 'red' }), syncAnswer(), ({ result, calls }) => {
  const L = labelsOf(calls);
  const i = (re) => L.findIndex((l) => re.test(l));
  const sync = calls.findIndex((c) => /set subStep sync/.test(c.prompt));
  const builder = i(/^backend: sync 01_rooms r1$/), guard = i(/^run: check-sync 01_rooms r1$/), tester = i(/^tester: red/);
  const prompt = calls[builder]?.prompt || '';
  return !result.status && sync >= 0 && builder > sync && guard > builder && tester > guard && !L.includes('frontend: sync 01_rooms r1')
    && /NotImplementedException/.test(prompt) && /COMPILE ERRORS: 3/.test(prompt) ? 0 : 1;
});
wf('workflow red: stage red — the sync makes no progress → STOPPED "sync: …", no tester', 1, wfArgs({ stage: 'red' }), syncAnswer({ compiles: [1] }), ({ result, calls }) =>
  (result.status === 'STOPPED' && /^sync: no progress/.test(result.failing[0]) && !labelsOf(calls).some((l) => /^tester: red/.test(l)) ? 1 : 0));
wf('workflow red: stage red — check-sync keeps rejecting → STOPPED, no tester', 1, wfArgs({ stage: 'red' }), syncAnswer({ compiles: [1, 0], guard: [2] }), ({ result, calls }) =>
  (result.status === 'STOPPED' && !labelsOf(calls).some((l) => /^tester: red/.test(l)) ? 1 : 0));
wf('workflow green: an invalid contract goes to the analyst once, then the sync continues', 0, wfArgs({ stage: 'red' }), syncAnswer({ valid: [1, 0], compiles: [0] }), ({ result, calls }) => {
  const L = labelsOf(calls);
  const a = L.findIndex((l) => /^analyst: repair contract 01_rooms$/.test(l)), t = L.findIndex((l) => /^tester: red/.test(l));
  return !result.status && a >= 0 && t > a && !L.some((l) => /sync 01_rooms r1/.test(l)) && /mapping values/.test(calls[a].prompt) ? 0 : 1;
});
wf('workflow red: the contract stays invalid after one repair → STOPPED, no builder, no tester', 1, wfArgs({ stage: 'red' }), syncAnswer({ valid: [1] }), ({ result, calls }) => {
  const L = labelsOf(calls);
  return result.status === 'STOPPED' && /^sync: contract invalid after one analyst repair/.test(result.failing[0]) && L.filter((l) => /^analyst: repair contract/.test(l)).length === 1
    && !L.some((l) => /^(backend|frontend): sync|^tester: red/.test(l)) ? 1 : 0;
});
wf('workflow green: a valid contract → no analyst repair', 0, wfArgs({ stage: 'red' }), syncAnswer({ compiles: [0] }), ({ calls }) => (!labelsOf(calls).some((l) => /^analyst: repair contract/.test(l)) ? 0 : 1));
wf('workflow green: stage red retry (redFeedback) runs the sync again — problem 6', 0, wfArgs({ stage: 'red', redFeedback: 'WRONG-REASON: backend: compile error in main (3)' }), syncAnswer(), ({ calls }) =>
  (labelsOf(calls).some((l) => /^backend: sync 01_rooms r1$/.test(l)) && !labelsOf(calls).some((l) => /^analyst: spec/.test(l)) ? 0 : 1));
wf('workflow green: unlisted older tests → the analyst lists them before the tester starts', 0, wfArgs({ stage: 'red' }), syncAnswer({ compiles: [0], unlisted: true }), ({ calls }) => {
  const L = labelsOf(calls);
  const a = L.findIndex((l) => /^analyst: list older tests 01_rooms$/.test(l)), t = L.findIndex((l) => /^tester: red/.test(l));
  return a >= 0 && t > a && /OldIT\.java/.test(calls[a].prompt) ? 0 : 1;
});
const unmodelled = (calls) => calls.filter((c) => !c.opts.model || !c.opts.effort).map((c) => c.opts.label || '?');
wf('models green: every agent call of a green stage with fix rounds and a failure names model + effort', 0, wfArgs({ stage: 'green', red: { exitCode: 0, output: '' }, maxRounds: 2 }),
  (p, o) => (/stack\.mjs" e2e-wait/.test(p) ? { exitCode: 1, output: 'E2E FAIL' } : ok0(p, o)), ({ result, calls }) => (result.status === 'BLOCKED' && !unmodelled(calls).length ? 0 : 1));
wf('models green: every agent call of a red stage with a contract sync names model + effort', 0, wfArgs({ stage: 'red' }), syncAnswer({ unlisted: true }), ({ calls }) => (!unmodelled(calls).length ? 0 : 1));
wf('models green: triage runs on opus/high and the tester on sonnet/high, whatever the session model', 0, wfArgs({ stage: 'green', red: { exitCode: 0, output: '' } }), triageSays({ code: '', tests: [{ file: 'e2e/tests/rooms.spec.ts', problem: 'x' }] }), ({ calls }) => {
  const t = calls.find((c) => /^triage/.test(c.opts.label || '')), te = calls.find((c) => /^tester: fix/.test(c.opts.label || ''));
  return t?.opts.model === 'opus' && t?.opts.effort === 'high' && te?.opts.model === 'sonnet' && te?.opts.effort === 'high' ? 0 : 1;
});
wf('workflow red: tester red prompt without self-check would be caught', 1, wfArgs({ stage: 'red' }), ok0, ({ calls }) => {
  const tester = calls.find((c) => c.opts.label?.startsWith('tester: red'));
  const stripped = tester.prompt.replace(/red-check/g, 'xxx');
  return /red-check\.mjs" --slice 01_rooms/.test(stripped) ? 0 : 1;
});
wf('workflow red: failed red-check → BLOCKED', 1, wfArgs({ stage: 'green', red: { exitCode: 2, output: 'COMPILE-ERROR' } }), ok0,
  ({ result }) => (result.status === 'BLOCKED' && result.failing.includes('red-check') ? 1 : 0));
wf('workflow green: verify → e2e → review → DONE', 0, wfArgs({ stage: 'green', red: { exitCode: 0, output: '' } }), ok0, ({ result, calls }) => {
  const order = calls.map((c) => c.prompt).map((p) => (LOOP_VERIFY.test(p) ? 'verify' : /stack\.mjs" e2e-wait/.test(p) ? 'e2e' : /check-review/.test(p) ? 'review' : null)).filter(Boolean);
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
wf('workflow green: official E2E = set subStep e2e && up, then detach, then wait — no subStep change in between', 0, wfArgs({ stage: 'green', red: { exitCode: 0, output: '' } }), ok0, ({ calls }) => {
  const runs = calls.filter((c) => c.opts.label?.startsWith('run:'));
  const up = runs.findIndex((c) => /stack\.mjs" up/.test(c.prompt));
  const det = runs.findIndex((c) => /stack\.mjs" e2e --detach/.test(c.prompt));
  const wait = runs.findIndex((c) => /stack\.mjs" e2e-wait --max 480/.test(c.prompt));
  const upP = runs[up]?.prompt || '';
  const setFirst = upP.indexOf('set subStep e2e') >= 0 && upP.indexOf('set subStep e2e') < upP.indexOf('stack.mjs" up');
  const noChange = runs.slice(up + 1, wait).every((c) => !/set subStep/.test(c.prompt));
  return up >= 0 && up < det && det < wait && setFirst && noChange ? 0 : 1;
});
const busyThen = (busyTimes) => { let n = 0; return (p, o) => (/stack\.mjs" e2e/.test(p) ? (n++ < busyTimes ? { exitCode: 3, output: 'STACK BUSY: e2e by pid 42 since x' } : { exitCode: 0, output: 'E2E PASS' }) : ok0(p, o)); };
const verifyAs = (fn) => (p, o) => (LOOP_VERIFY.test(p) ? fn(p, o) : ok0(p, o));
const triaged = (calls) => calls.some((c) => /^triage/.test(c.opts.label || ''));
wf('workflow green: runner says 1 but the sentinel says 0 → verify GREEN, DONE', 0, wfArgs({ stage: 'green', red: { exitCode: 0, output: '' } }),
  verifyAs(() => ({ exitCode: 1, output: 'node: something: No such file or directory\nORACUL_EXIT=0', raw: true })), ({ result, calls }) => (result.status === 'DONE' && !triaged(calls) ? 0 : 1));
wf('workflow red: runner says 0 but the sentinel says 1 → verify RED, triaged', 1, wfArgs({ stage: 'green', red: { exitCode: 0, output: '' }, maxRounds: 1 }),
  verifyAs(() => ({ exitCode: 0, output: 'FAIL backend\nORACUL_EXIT=1', raw: true })), ({ calls }) => (triaged(calls) ? 1 : 0));
wf('workflow red: no sentinel twice → STOPPED "verify: runner returned no exit code", no triage, not parked', 1, wfArgs({ stage: 'green', red: { exitCode: 0, output: '' } }),
  verifyAs(() => ({ exitCode: 0, output: 'looks fine', raw: true })), ({ result, calls }) =>
    (result.status === 'STOPPED' && result.failing.includes('verify: runner returned no exit code') && !triaged(calls) && !parked(calls)
      && calls.filter((c) => LOOP_VERIFY.test(c.prompt)).length === 2 ? 1 : 0));
wf('workflow green: no sentinel once, then present → normal, DONE', 0, wfArgs({ stage: 'green', red: { exitCode: 0, output: '' } }), (() => {
  let n = 0;
  return verifyAs(() => (n++ ? { exitCode: 0, output: 'GREEN' } : { exitCode: 0, output: 'truncated', raw: true }));
})(), ({ result, calls }) => (result.status === 'DONE' && calls.filter((c) => LOOP_VERIFY.test(c.prompt)).length === 2 ? 0 : 1));
wf('workflow red: runner timeout 124 → STOPPED "verify: timed out", not rerun, no triage', 1, wfArgs({ stage: 'green', red: { exitCode: 0, output: '' } }),
  verifyAs(() => ({ exitCode: 124, output: 'BUILD …' })), ({ result, calls }) =>
    (result.status === 'STOPPED' && result.failing.includes('verify: timed out') && !triaged(calls)
      && calls.filter((c) => LOOP_VERIFY.test(c.prompt)).length === 1 ? 1 : 0));
wf('workflow green: exitSource "runner" restores the old behaviour (runner exitCode, no sentinel appended)', 0, wfArgs({ stage: 'green', red: { exitCode: 0, output: '' }, exitSource: 'runner', maxRounds: 1 }),
  verifyAs(() => ({ exitCode: 1, output: 'ORACUL_EXIT=0', raw: true })), ({ calls }) =>
    (triaged(calls) && !calls.some((c) => /ORACUL_EXIT=\$\?/.test(c.prompt)) ? 0 : 1));
wf('workflow red: close chain without exit code → STOPPED "close: …", slice not parked', 1, wfArgs({ stage: 'green', red: { exitCode: 0, output: '' } }),
  (p, o) => (/commit\.mjs"/.test(p) && /slice 01_rooms DONE/.test(p) ? { exitCode: 0, output: '', raw: true } : ok0(p, o)), ({ result, calls }) =>
    (result.status === 'STOPPED' && result.failing.includes('close: runner returned no exit code') && !parked(calls) ? 1 : 0));
const waitAnswers = (codes) => { let n = 0; return (p, o) => (/stack\.mjs" e2e-wait/.test(p) ? (() => { const c = codes[Math.min(n++, codes.length - 1)]; return { exitCode: c, output: c === 75 ? 'E2E STILL RUNNING (480s since start)' : c === 4 ? 'E2E WORKER LOST: worker pid 9 is gone' : 'E2E PASS' }; })() : ok0(p, o)); };
const waits = (calls) => calls.filter((c) => /stack\.mjs" e2e-wait/.test(c.prompt)).length;
wf('workflow green: long E2E — wait says 75 three times, then 0 → DONE, no triage', 0, wfArgs({ stage: 'green', red: { exitCode: 0, output: '' } }), waitAnswers([75, 75, 75, 0]), ({ result, calls }) =>
  (result.status === 'DONE' && waits(calls) === 4 && !triaged(calls) ? 0 : 1));
wf('workflow red: E2E never finishes → STOPPED "e2e: timed out" after 8 waits, no triage', 1, wfArgs({ stage: 'green', red: { exitCode: 0, output: '' } }), waitAnswers([75]), ({ result, calls }) =>
  (result.status === 'STOPPED' && result.failing.includes('e2e: timed out') && waits(calls) === 8 && !triaged(calls) ? 1 : 0));
wf('workflow red: E2E worker died → STOPPED "e2e: e2e worker lost", no triage', 1, wfArgs({ stage: 'green', red: { exitCode: 0, output: '' } }), waitAnswers([75, 4]), ({ result, calls }) =>
  (result.status === 'STOPPED' && result.failing.includes('e2e: e2e worker lost') && !triaged(calls) ? 1 : 0));
const CLOSE = /verify\.mjs" --reuse-if-fresh[\s\S]*slice 01_rooms DONE/;
const failureNoted = (calls) => calls.some((c) => /^failure note/.test(c.opts.label || ''));
wf('workflow red: close fails (a check says INVALID) → STOPPED "close: INVALID …", not parked, no failure note', 1, wfArgs({ stage: 'green', red: { exitCode: 0, output: '' } }),
  (p, o) => (CLOSE.test(p) ? { exitCode: 1, output: 'verify: reusing the full GREEN verify of x\nINVALID  docs/phase-01_mvp/02_specs [sliceSpec] — FR-1 lacks "- Ranges & invariants"\nRESULT  FAIL (1 problem)' } : ok0(p, o)),
  ({ result, calls }) => (result.status === 'STOPPED' && result.failing.some((f) => /^close: INVALID .*sliceSpec/.test(f)) && !parked(calls) && !failureNoted(calls)
    && calls.some((c) => /set subStep green/.test(c.prompt) && /close failed/.test(c.opts.label || '')) ? 1 : 0));
wf('workflow red: close re-verify finds RED → STOPPED "close: ==== VERIFY RED …", not parked', 1, wfArgs({ stage: 'green', red: { exitCode: 0, output: '' } }),
  (p, o) => (CLOSE.test(p) ? { exitCode: 1, output: 'verify: test/coverage output changed after it (backend/build/reports/jacoco/test/jacocoTestReport.xml) — running a full verify\n==== VERIFY RED: backend ====' } : ok0(p, o)),
  ({ result, calls }) => (result.status === 'STOPPED' && result.failing.some((f) => /^close: ==== VERIFY RED/.test(f)) && !parked(calls) ? 1 : 0));
wf('workflow green: close = re-verify if needed → artifacts → coverage --update → commit → DONE → subStep none, in that order', 0, wfArgs({ stage: 'green', red: { exitCode: 0, output: '' } }), ok0, ({ result, calls }) => {
  const c = calls.find((x) => CLOSE.test(x.prompt));
  if (!c || result.status !== 'DONE') return 1;
  const p = runnerCommand(c.prompt);
  const at = ['verify.mjs" --reuse-if-fresh', 'check-artifacts.mjs" --step 04_build --slice 01_rooms --stage done', 'check-coverage.mjs" --update', 'commit.mjs" --message', 'slice 01_rooms DONE', 'set subStep none', 'ORACUL_EXIT'].map((x) => p.indexOf(x));
  return at.every((v, i) => v >= 0 && (i === 0 || v > at[i - 1])) ? 0 : 1;
});
const START = /check-artifacts\.mjs" --step 04_build --slice 01_rooms --stage red/;
const builders = (calls) => calls.filter((c) => /^(backend|frontend): /.test(c.opts.label || '')).length;
wf('workflow red: slice spec lines missing at green start → STOPPED "start: INVALID …", no builder ran', 1, wfArgs({ stage: 'green', red: { exitCode: 0, output: '' } }),
  (p, o) => (START.test(p) ? { exitCode: 1, output: 'INVALID  docs/phase-01_mvp/02_specs [sliceSpec] — FR-1 (rooms.md) lacks "- Ranges & invariants: none | <ranges and invariants>"\nRESULT  FAIL (1 problem)' } : ok0(p, o)),
  ({ result, calls }) => (result.status === 'STOPPED' && result.failing.some((f) => /^start: INVALID .*Ranges & invariants/.test(f)) && builders(calls) === 0 && !parked(calls) ? 1 : 0));
wf('workflow green: complete docs at green start → the builders run', 0, wfArgs({ stage: 'green', red: { exitCode: 0, output: '' } }), ok0, ({ result, calls }) => {
  const i = calls.findIndex((c) => START.test(c.prompt));
  const firstBuilder = calls.findIndex((c) => /^(backend|frontend): /.test(c.opts.label || ''));
  return result.status === 'DONE' && i >= 0 && firstBuilder > i ? 0 : 1;
});
wf('workflow green: a failed red-check skips the start check (BLOCKED as before)', 0, wfArgs({ stage: 'green', red: { exitCode: 2, output: 'COMPILE-ERROR' } }), ok0, ({ result, calls }) =>
  (result.status === 'BLOCKED' && !calls.some((c) => START.test(c.prompt)) ? 0 : 1));
const between = (calls, from, to) => calls.slice(from + 1, to);
wf('workflow green: stack busy once → rerun, no fix round, DONE', 0, wfArgs({ stage: 'green', red: { exitCode: 0, output: '' } }), busyThen(1), ({ result, calls }) => {
  const idx = calls.map((c, i) => (/stack\.mjs" e2e/.test(c.prompt) ? i : -1)).filter((i) => i >= 0);
  const mid = between(calls, idx[0], idx.at(-1));
  const detaches = calls.filter((c) => /stack\.mjs" e2e --detach/.test(c.prompt)).length;
  return result.status === 'DONE' && detaches === 2 && !mid.some((c) => /^(triage|tester|backend|frontend)/.test(c.opts.label || '')) ? 0 : 1;
});
wf('workflow red: stack busy twice → STOPPED "e2e: stack busy", never triaged, not parked', 1, wfArgs({ stage: 'green', red: { exitCode: 0, output: '' } }), busyThen(2), ({ result, calls }) =>
  (result.status === 'STOPPED' && result.failing.includes('e2e: stack busy') && !calls.some((c) => /^triage/.test(c.opts.label || '')) && !parked(calls) ? 1 : 0));
const GUARD_OUT = 'PreToolUse:Bash hook error: [node "/e/hooks/guard-edits.mjs"]: [oracul guard] `node "/e/bin/stack.mjs" e2e` is a stack operation: …'
const refuse = (re) => (p, o) => (re.test(p) ? { exitCode: 1, output: GUARD_OUT } : ok0(p, o));
const parked = (calls) => calls.some((c) => /checkout HEAD -- backend|slice 01_rooms BLOCKED/.test(c.prompt));
const oneRoundNoTriage = (calls) => !calls.some((c) => /^triage/.test(c.opts.label || '')) && !calls.some((c) => / r2$/.test(c.opts.label || ''));
wf('workflow red: E2E refused by the guard → STOPPED "e2e: blocked by guard hook", never triaged, one round, not parked', 1, wfArgs({ stage: 'green', red: { exitCode: 0, output: '' } }), refuse(/stack\.mjs" e2e/), ({ result, calls }) =>
  (result.status === 'STOPPED' && result.failing.includes('e2e: blocked by guard hook') && oneRoundNoTriage(calls) && !parked(calls) ? 1 : 0));
wf('workflow red: verify refused by the guard → STOPPED "verify: blocked by guard hook", never triaged, one round, not parked', 1, wfArgs({ stage: 'green', red: { exitCode: 0, output: '' } }), refuse(LOOP_VERIFY), ({ result, calls }) =>
  (result.status === 'STOPPED' && result.failing.includes('verify: blocked by guard hook') && oneRoundNoTriage(calls) && !parked(calls) ? 1 : 0));
wf('workflow green: a real E2E failure is still triaged (not mistaken for a guard block)', 0, wfArgs({ stage: 'green', red: { exitCode: 0, output: '' } }), (() => {
  let n = 0;
  return (p, o) => (/stack\.mjs" e2e-wait/.test(p) && !n++ ? { exitCode: 1, output: 'E2E FAIL\n  1 failed: rooms.spec.ts' } : ok0(p, o));
})(), ({ result, calls }) => (result.status === 'DONE' && calls.some((c) => /^triage: E2E/.test(c.opts.label || '')) ? 0 : 1));
const BLOCK = '==== E2E FAILURES (1) ====\n✘ rooms.spec.ts › FR-1 create room\n    Error: not visible\n==== END E2E FAILURES ===='
wf('workflow green: E2E FAILURES block reaches the next fix round; builders told not to run E2E', 0, wfArgs({ stage: 'green', red: { exitCode: 0, output: '' } }), (() => {
  let n = 0;
  return (p, o) => (/stack\.mjs" e2e-wait/.test(p) ? (n++ ? { exitCode: 0, output: 'E2E PASS' } : { exitCode: 1, output: `E2E FAIL\n${BLOCK}` }) : ok0(p, o));
})(), ({ result, calls }) => {
  const be2 = calls.find((c) => c.opts.label === 'backend: 01_rooms r2');
  const be1 = calls.find((c) => c.opts.label === 'backend: 01_rooms r1');
  const tri = calls.findIndex((c) => /^triage: E2E/.test(c.opts.label || ''));
  const greenBeforeTriage = /set subStep green/.test(calls[tri - 1]?.prompt || '');
  return result.status === 'DONE' && be2 && be2.prompt.includes(BLOCK) && !be1.prompt.includes('E2E FAILURES ====')
    && /Do not run Playwright/.test(be1.prompt) && greenBeforeTriage ? 0 : 1;
});
wf('workflow green: a note() with ``` blocks is fenced so the runner sees the whole command', 0, wfArgs({ stage: 'green', red: { exitCode: 0, output: '' } }), (() => { let n = 0; return (p, o) => (/stack\.mjs" e2e-wait/.test(p) && !n++ ? { exitCode: 1, output: 'E2E FAIL' } : ok0(p, o)); })(), ({ calls }) => {
  const n = calls.find((c) => c.opts.label === 'run: note Round 1');
  return n && /```/.test(runnerCommand(n.prompt)) && /ORACUL_EOF$/.test(runnerCommand(n.prompt)) ? 0 : 1;
});
const GRADLE_CLI = "FAILURE: Build failed with an exception.\n* What went wrong:\nProblem configuring task :jacocoTestReport from command line.\n> Unknown command-line option '--tests'.";
wf('workflow red: a Gradle command-line error in verify → STOPPED (factory bug), no triage, no fix round', 1, wfArgs({ stage: 'green', red: { exitCode: 0, output: '' } }),
  verifyAs(() => ({ exitCode: 1, output: GRADLE_CLI })), ({ result, calls }) =>
    (result.status === 'STOPPED' && /^verify: factory command error \(Problem configuring task :jacocoTestReport/.test(result.failing[0]) && !triaged(calls) && !calls.some((c) => / r2$/.test(c.opts.label || '')) ? 1 : 0));
wf('workflow green: a real test failure is still triaged (not taken for a harness error)', 0, wfArgs({ stage: 'green', red: { exitCode: 0, output: '' }, maxRounds: 1 }),
  verifyAs(() => ({ exitCode: 1, output: 'RoomsApiIT > createsRoom() FAILED\n    AssertionFailedError: Status expected:<201> but was:<501>' })), ({ calls }) => (triaged(calls) ? 0 : 1));
const parkAnswer = (parkCode) => (p, o) => (LOOP_VERIFY.test(p) ? { exitCode: 1, output: 'RED' } : /checkout HEAD -- backend/.test(p) ? { exitCode: parkCode, output: parkCode ? 'Permission denied: git clean' : 'committed abc' } : ok0(p, o));
wf('workflow red: the park is refused → STOPPED "park: …", the slice is not marked BLOCKED', 1, wfArgs({ stage: 'green', red: { exitCode: 0, output: '' }, maxRounds: 1 }), parkAnswer(1), ({ result, calls }) => {
  const parkCmd = runnerCommand(calls.find((c) => /checkout HEAD -- backend/.test(c.prompt))?.prompt || '');
  return result.status === 'STOPPED' && result.failing.some((f) => /^park: exit 1/.test(f)) && parkCmd.indexOf('BLOCKED') > parkCmd.indexOf('checkout HEAD') ? 1 : 0;
});
wf('workflow green: a park that runs → BLOCKED with the impact read before it', 0, wfArgs({ stage: 'green', red: { exitCode: 0, output: '' }, maxRounds: 1 }), parkAnswer(0), ({ result, calls }) => {
  const i = calls.findIndex((c) => /state\.mjs" impact 01_rooms/.test(c.prompt)), p = calls.findIndex((c) => /checkout HEAD -- backend/.test(c.prompt));
  return result.status === 'BLOCKED' && result.decision === 'CONTINUE' && i >= 0 && p > i ? 0 : 1;
});
const stopLog = (calls) => calls.filter((c) => c.opts.label?.startsWith('run: log stop')).map((c) => runnerCommand(c.prompt));
wf('notes green: a STOPPED by a factory command error is logged as factory-false-positive + backlog', 0, wfArgs({ stage: 'green', red: { exitCode: 0, output: '' } }),
  verifyAs(() => ({ exitCode: 1, output: "Problem configuring task :jacocoTestReport from command line.\n> Unknown command-line option '--tests'." })),
  ({ result, calls }) => { const l = stopLog(calls); return result.status === 'STOPPED' && l.length === 1 && /--tag factory-false-positive --issue$/.test(l[0]) ? 0 : 1; });
wf('notes green: an infrastructure STOPPED is tagged infra, no backlog entry', 0, wfArgs({ stage: 'green', red: { exitCode: 0, output: '' } }), busyThen(2),
  ({ calls }) => { const l = stopLog(calls); return l.length === 1 && /--tag infra$/.test(l[0]) ? 0 : 1; });
wf('notes red: a DONE slice logs no stop', 1, wfArgs({ stage: 'green', red: { exitCode: 0, output: '' } }), ok0, ({ calls }) => (stopLog(calls).length ? 0 : 1));
for (const c of asyncCases) {
  wfStarted = true;
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
    if (o.label?.startsWith('run: note')) cmds.push(runnerCommand(p));
    return LOOP_VERIFY.test(p) ? { exitCode: 1, output: `verify RED #${++v}` } : ok0(p, o);
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
  ['workflow green: release long E2E — wait 75 twice, then 0 → GREEN, no triage', 0, () => waitAnswers([75, 75, 0]), null],
  ['workflow red: release E2E never finishes → RED "e2e: timed out", no triage', 1, () => waitAnswers([75]), 'e2e: timed out'],
  ['workflow red: release E2E refused by the guard → RED "e2e: blocked by guard hook", never triaged', 1, () => refuse(/stack\.mjs" e2e/), 'e2e: blocked by guard hook'],
  ['workflow red: release verify refused by the guard → RED "verify: blocked by guard hook", never triaged', 1, () => refuse(/checks\/verify\.mjs" --scope all/), 'verify: blocked by guard hook'],
]) {
  if (filter && !name.includes(filter)) continue;
  let got, note = '';
  try {
    const { result, calls } = await runWorkflow('finish-and-run.js', relArgs, answer());
    const triaged = calls.some((c) => /^triage/.test(c.opts.label || ''));
    got = problem ? (result.status === 'RED' && result.problems.includes(problem) && !triaged ? 1 : 0) : (result.status === 'GREEN' && !triaged ? 0 : 1);
    if (!got) note = JSON.stringify(result).slice(0, 300);
  } catch (e) { got = 'ERR'; note = String(e); }
  results.push({ name, ok: got === expectCode, expectCode, got, note, out: '' });
}
{
  const name = 'models green: every agent call of the release (with a fix round) names model + effort';
  if (!filter || name.includes(filter)) {
    let got, note = '';
    try {
      let n = 0;
      const { calls } = await runWorkflow('finish-and-run.js', relArgs, (p, o) => (/checks\/verify\.mjs" --scope all/.test(p) && !n++ ? { exitCode: 1, output: 'RED' } : ok0(p, o)));
      const bad = unmodelled(calls);
      got = bad.length ? 1 : 0; note = bad.join(', ');
    } catch (e) { got = 'ERR'; note = String(e); }
    results.push({ name, ok: got === 0, expectCode: 0, got, note, out: '' });
  }
}
{
  const name = 'models red: a triage call without a model would be caught';
  if (!filter || name.includes(filter)) {
    let got, note = '';
    try {
      const src = fs.readFileSync(path.join(ENGINE, 'workflows', 'build-slice.js'), 'utf8');
      const mutated = src.replace("schema: TRIAGE_SCHEMA, model: 'opus', effort: 'high' })", 'schema: TRIAGE_SCHEMA })');
      if (mutated === src) throw new Error('mutation did not apply — update this case');
      const { calls } = await runWorkflow('build-slice.js', wfArgs({ stage: 'green', red: { exitCode: 0, output: '' } }), triageSays({ code: 'x', tests: [] }), mutated);
      got = unmodelled(calls).some((l) => /^triage/.test(l)) ? 1 : 0;
    } catch (e) { got = 'ERR'; note = String(e); }
    results.push({ name, ok: got === 1, expectCode: 1, got, note, out: '' });
  }
}
for (const [name, expectCode, answer] of [
  ['workflow red: release verify refused by the guard → stops early: no E2E, no QA, no release commit', 1, () => refuse(/checks\/verify\.mjs" --scope all/)],
  ['workflow green: clean release runs verify → review → E2E → QA → commit in order', 0, () => ok0],
]) {
  if (filter && !name.includes(filter)) continue;
  let got, note = '';
  try {
    const { result, calls } = await runWorkflow('finish-and-run.js', relArgs, answer());
    const at = (re) => calls.findIndex((c) => re.test(c.prompt) || re.test(c.opts.label || ''));
    const idx = [/checks\/verify\.mjs" --scope all/, /check-review\.mjs" --release/, /stack\.mjs" e2e-wait/, /^qa-documenter/, /commit\.mjs" --message ".* 05_release/].map(at);
    const ranAll = idx.every((i) => i >= 0) && idx.every((v, i) => i === 0 || v > idx[i - 1]);
    const ranNone = idx.slice(2).every((i) => i < 0);
    got = result.stoppedEarly && result.status === 'RED' && ranNone ? 1 : !result.stoppedEarly && result.status === 'GREEN' && ranAll ? 0 : 'other';
    if (got === 'other') note = `${JSON.stringify(idx)} ${JSON.stringify(result).slice(0, 200)}`;
  } catch (e) { got = 'ERR'; note = String(e); }
  results.push({ name, ok: got === expectCode, expectCode, got, note, out: '' });
}
for (const [name, expectCode, fresh] of [
  ['workflow green: release reuses a full E2E run that passed on exactly this code — stack up, no new Playwright run', 0, 0],
  ['workflow red: release runs Playwright when the last full run does not cover the code', 1, 1],
]) {
  if (filter && !name.includes(filter)) continue;
  let got, note = '';
  try {
    const { result, calls } = await runWorkflow('finish-and-run.js', relArgs, (p, o) => (FRESH_PROBE.test(p) ? { exitCode: fresh, output: fresh ? 'INVALID code changed' : 'PASS covered' } : ok0(p, o)));
    const detached = calls.some((c) => /stack\.mjs" e2e --detach/.test(c.prompt));
    const upped = calls.some((c) => /stack\.mjs" up/.test(c.prompt));
    got = result.status === 'GREEN' && upped ? (detached ? 1 : 0) : 'other';
    if (got === 'other') note = JSON.stringify(result).slice(0, 300);
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
// verify --reuse-if-fresh takes its skip path in the sandbox (fresh GREEN lastVerify), so the close chain runs for real.
const NEEDS_TOOLS = /checks\/verify\.mjs"(?! --reuse-if-fresh)|bin\/stack\.mjs"|gradlew|red-check\.mjs"/;
const SHELL_ERROR = /syntax error|unexpected end of file|here-document .*delimited by end-of-file|command not found|unbound variable/;
async function replayThroughHook(file, args, answer, source, { execute = false } = {}) {
  const sb = sandbox();
  sb.state({ step: file === 'build-slice.js' ? '04_build' : '05_release', slice: '01_rooms', subStep: 'green' });
  if (execute) { // commit.mjs needs a repo
    spawnSync('git', ['init', '-q'], { cwd: sb.appDir });
    spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init', '--allow-empty'], { cwd: sb.appDir });
  }
  const blocked = [];
  const executed = [];
  const closeOutputs = [];
  const { result } = await runWorkflow(file, { ...args, engine: ENGINE, root: sb.root, appDir: sb.appDir, phaseDir: sb.doc('') }, (p, o) => {
    if (o.label?.startsWith('run:')) {
      const cmd = runnerCommand(p);
      const h = hook(sb, 'guard-edits', { tool_name: 'Bash', tool_input: { command: cmd } });
      if (h.code !== 0) blocked.push(`${o.label}: ${h.out.trim().slice(0, 160)}`);
      if (execute && h.code === 0 && !NEEDS_TOOLS.test(cmd)) {
        const x = spawnSync('bash', ['-c', cmd], { cwd: sb.root, env: sb.env, encoding: 'utf8' });
        const out = (x.stdout || '') + (x.stderr || '');
        const gate = /ORACUL_EXIT=\$\?/.test(cmd);
        executed.push(o.label);
        if (SHELL_ERROR.test(x.stderr || '')) blocked.push(`${o.label}: shell error: ${(x.stderr || '').trim().slice(0, 160)}`);
        if (o.label.startsWith('run: note ')) { // bash 3.2 accepts a broken heredoc silently — check what landed in the file
          const title = o.label.slice('run: note '.length);
          const rounds = sb.read('docs/phase-01_mvp/04_build/01_rooms/rounds.md') || '';
          if (!rounds.includes(`## ${title}`) || /ORACUL_EO/.test(rounds)) blocked.push(`${o.label}: shell error: note did not land cleanly in rounds.md`);
        }
        else if (gate && !/ORACUL_EXIT=\d+\s*$/.test(out.trimEnd() + '\n')) blocked.push(`${o.label}: gate printed no ORACUL_EXIT as its last line`);
        // The real close chain must succeed in the sandbox, reusing the round's verify (no extra time on a normal close).
        if (o.label.startsWith('run: close ') && !(/ORACUL_EXIT=0\s*$/.test(out.trimEnd() + '\n') && /verify: reusing the full GREEN verify/.test(out)))
          blocked.push(`${o.label}: close chain did not pass via the reuse path: ${out.trim().slice(-300)}`);
        if (o.label.startsWith('run: close ')) closeOutputs.push(out);
        if (o.label.startsWith('run: start checks ') && !/ORACUL_EXIT=0\s*$/.test(out.trimEnd() + '\n')) blocked.push(`${o.label}: start check failed on the fixture: ${out.trim().slice(-300)}`);
      }
      for (const m of cmd.matchAll(/set subStep (\S+)/g)) sb.state({ subStep: m[1] });
    }
    return answer(p, o);
  }, source);
  fs.rmSync(sb.root, { recursive: true, force: true });
  return { result, blocked, executed, closeOutputs };
}
const e2eFailsOnce = () => { let n = 0; return (p, o) => (/stack\.mjs" e2e-wait/.test(p) && !n++ ? { exitCode: 1, output: `E2E FAIL\n${BLOCK}` } : ok0(p, o)); };
{
  const name = 'replay green: build-slice red stage with a contract sync — every command passes the guard';
  if (!filter || name.includes(filter)) {
    let got, note = '';
    try { const r = await replayThroughHook('build-slice.js', wfArgs({ stage: 'red' }), syncAnswer()); got = r.blocked.length ? 1 : 0; note = r.blocked.join(' | '); } catch (e) { got = 'ERR'; note = String(e); }
    results.push({ name, ok: got === 0, expectCode: 0, got, note, out: '' });
  }
}
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
// EXECUTING replay: every command that needs no Docker/Gradle runs for real in bash in the sandbox — no shell errors,
// and every gate command ends with its ORACUL_EXIT line.
for (const [name, file, args] of [
  ['executing replay green: build-slice green stage runs cleanly in bash', 'build-slice.js', wfArgs({ stage: 'green', red: { exitCode: 0, output: '' } })],
  ['executing replay green: build-slice red stage runs cleanly in bash', 'build-slice.js', wfArgs({ stage: 'red' })],
  ['executing replay green: finish-and-run runs cleanly in bash', 'finish-and-run.js', relArgs],
]) {
  if (filter && !name.includes(filter)) continue;
  let got, note = '';
  try {
    const r = await replayThroughHook(file, args, e2eFailsOnce(), undefined, { execute: true });
    const needsClose = file === 'build-slice.js' && args.stage === 'green';
    got = r.blocked.length || !r.executed.length || (needsClose && !r.closeOutputs.length) ? 1 : 0;
    note = r.blocked.join(' | ') || `${r.executed.length} commands executed${needsClose ? ` · close: ${(r.closeOutputs[0] || 'NOT RUN').split('\n').find((l) => /reusing/.test(l)) || 'no reuse line'}` : ''}`;
  } catch (e) { got = 'ERR'; note = String(e); }
  results.push({ name, ok: got === 0, expectCode: 0, got, note, out: '' });
}
{
  const name = 'executing replay red: a note() with a broken heredoc is caught';
  if (!filter || name.includes(filter)) {
    let got, note = '';
    try {
      const src = fs.readFileSync(path.join(ENGINE, 'workflows', 'build-slice.js'), 'utf8');
      const mutated = src.replace("\\n${body}\\nORACUL_EOF`, `note ${title}`)", "\\n${body}\\nORACUL_EO`, `note ${title}`)");
      if (mutated === src) throw new Error('mutation did not apply — update this case');
      const r = await replayThroughHook('build-slice.js', wfArgs({ stage: 'green', red: { exitCode: 0, output: '' } }), e2eFailsOnce(), mutated, { execute: true });
      got = r.blocked.some((b) => /shell error/.test(b)) ? 1 : 0;
      note = r.blocked[0] || 'nothing caught';
    } catch (e) { got = 'ERR'; note = String(e); }
    results.push({ name, ok: got === 1, expectCode: 1, got, note, out: '' });
  }
}
{
  const name = 'runner fence red: a plain ``` fence cuts a note command short';
  if (!filter || name.includes(filter)) {
    const cmd = "cat <<'ORACUL_EOF'\n- Output:\n\n```\nlog\n```\nORACUL_EOF";
    const cut = (`\`\`\`bash\n${cmd}\n\`\`\`\n`.match(/```bash\n([\s\S]*?)\n```/) || [])[1];
    results.push({ name, ok: cut !== cmd, expectCode: 1, got: cut !== cmd ? 1 : 0, note: 'plain fence ends at the inner ```', out: '' });
  }
}
// The sentinel reports the status of the whole && chain, including non-node commands (git) — real bash.
for (const [name, cmd, want] of [
  ['sentinel green: successful chain → ORACUL_EXIT=0', 'true && true\necho "ORACUL_EXIT=$?"', 0],
  ['sentinel red: git failing mid-chain → ORACUL_EXIT=128, not the earlier success', 'true && git -C /nonexistent-oracul status && true\necho "ORACUL_EXIT=$?"', 128],
]) {
  if (filter && !name.includes(filter)) continue;
  const x = spawnSync('bash', ['-c', cmd], { encoding: 'utf8' });
  const m = (x.stdout.match(/ORACUL_EXIT=(\d+)\s*$/) || [])[1];
  results.push({ name, ok: Number(m) === want, expectCode: want, got: m === undefined ? 'none' : Number(m), note: '', out: '' });
}
{ // red counterpart: a workflow that runs E2E without switching to subStep e2e is caught by the replay
  const name = 'replay red: E2E run while still in subStep green is caught';
  if (!filter || name.includes(filter)) {
    let got, note = '';
    try {
      const src = fs.readFileSync(path.join(ENGINE, 'workflows', 'build-slice.js'), 'utf8');
      const mutated = src.replace("`${node('bin/state.mjs', 'set subStep e2e')} && ${node('bin/stack.mjs', 'up --mode e2e')}`", "node('bin/stack.mjs', 'up --mode e2e')");
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
