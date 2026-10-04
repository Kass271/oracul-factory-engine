// Analysis behind bin/red-check.mjs: are the slice's RED tests red for the RIGHT reason and could they ever pass?
// Pure over its inputs (layer outputs, JUnit XML reports, the changed-file list) so the self-test can drive it.
import fs from 'node:fs';
import path from 'node:path';
import { exists, readJson, readText, tail, today, writeJson } from './core.mjs';
import { collectTraces, parsePlan, parseSpecFrs } from './docs.mjs';
import { diagnostics } from './compile.mjs';

// What a compile error means, by where it is (checks/lib/compile.mjs labels).
const COMPILE_MEANS = {
  main: 'production code does not compile (contract fallout?) — the contract sync step repairs it, never the tester',
  generated: 'generated code does not compile — a contract problem for the analyst',
  'test-new': 'a new or changed test does not compile — fix the test (use seams that exist before the code)',
  'test-old': 'an older test no longer compiles — list it under "Changes earlier behaviour" and update it',
  unknown: 'compile error (location not recognised — see the compiler output)',
};
export function compileProblems(layer, d) {
  const out = [];
  for (const [label, n] of Object.entries(d.labels)) {
    if (!n) continue;
    const where = d.files.filter((f) => f.label === label).slice(0, 3).map((f) => `${f.rel}:${f.line}`).join(', ');
    out.push(`${layer}: compile error in ${label} (${n}) — ${COMPILE_MEANS[label]}${where ? `: ${where}` : ''}`);
  }
  return out.length ? out : [`${layer}: compile error — ${COMPILE_MEANS.unknown}`];
}

const COMPILE = {
  backend: /compile(Test)?Java FAILED|Compilation failed|error: cannot find symbol|error: package .* does not exist/,
  frontend: /error TS\d+|\[ERROR\] TS\d+|Could not resolve|Failed to resolve import|Cannot find module/,
};

// Failure signatures that point at a bug in the TEST, not at missing behaviour.
const TEST_BUGS = [
  [/org\.mockito\.exceptions\./, 'Mockito misuse (unused/unfinished stubbing, wrong matchers) — script exactly the stubs the code path needs'],
  [/Failed to load ApplicationContext|UnsatisfiedDependencyException|NoSuchBeanDefinitionException/, 'Spring test context does not start — test configuration bug (wires a bean that does not exist yet?)'],
  [/ClassCastException|NoSuchMethodError|NoClassDefFoundError/, 'type/linkage error inside the test'],
  [/NullInjectorError/, 'Angular TestBed is missing a provider — test configuration bug'],
];
// "expected:<5> but was:<5>" — equal text, different types (int vs long, "5" vs 5): can never pass.
const SAME_VALUE = /expected:?\s*(?:[\w.$]+@[0-9a-f]+\s*)?<([^>\n]*)>\s*but was:?\s*(?:[\w.$]+@[0-9a-f]+\s*)?<([^>\n]*)>/g;
// A test that covers a range or invariant: parameterized, table-driven or looping over the domain.
const EXHAUSTIVE = /@(?:[\w.]+\.)?(?:ParameterizedTest|MethodSource|ValueSource|CsvSource|EnumSource|RepeatedTest)\b|\b(?:it|test|describe)\.each\b|\bfor\s*\(|\.forEach\s*\(|IntStream\.range/;

const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#10;/g, '\n').replace(/&amp;/g, '&');

// Failed/errored test cases from Gradle's JUnit XML reports written at or after `since` (ms).
export function junitFailures(dir, since = 0) {
  if (!exists(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir).filter((x) => /^TEST-.*\.xml$/.test(x))) {
    const p = path.join(dir, f);
    if (fs.statSync(p).mtimeMs < since) continue;
    for (const m of (readText(p) || '').matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
      const fm = (m[2] || '').match(/<(failure|error)\b([^>]*)>([\s\S]*?)<\/\1>|<(failure|error)\b([^>]*)\/>/);
      if (!fm) continue;
      const attr = (s, k) => decode((String(s).match(new RegExp(`\\b${k}="([^"]*)"`)) || [])[1] || '');
      const head = fm[2] ?? fm[5];
      out.push({
        classname: attr(m[1], 'classname'), name: attr(m[1], 'name'), type: attr(head, 'type'),
        text: `${attr(head, 'type')}: ${attr(head, 'message')}\n${decode(fm[3] || '').split('\n').slice(0, 15).join('\n')}`,
      });
    }
  }
  return out;
}

// Every attempt of every test case in Gradle's JUnit XML reports written at or after `since` (ms). With the test-retry
// plugin a retried test appears once per attempt. → Map "class#name" → { classname, name, file, attempts: [{ ok }] }
export function junitCases(dir, since = 0) {
  const cases = new Map();
  if (!exists(dir)) return cases;
  for (const f of fs.readdirSync(dir).filter((x) => /^TEST-.*\.xml$/.test(x))) {
    const p = path.join(dir, f);
    if (fs.statSync(p).mtimeMs < since) continue;
    for (const m of (readText(p) || '').matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
      const attr = (k) => decode((m[1].match(new RegExp(`\\b${k}="([^"]*)"`)) || [])[1] || '');
      const body = m[2] || '';
      if (/<skipped\b/.test(body)) continue;
      const key = `${attr('classname')}#${attr('name')}`;
      if (!cases.has(key)) cases.set(key, { classname: attr('classname'), name: attr('name'), file: javaTestFile(attr('classname')), attempts: [] });
      cases.get(key).attempts.push({ ok: !/<(failure|error)\b/.test(body) });
    }
  }
  return cases;
}
// Tests that failed and then passed on a retry (flaky), as "Class.name".
export const flakyCases = (cases) => [...cases.values()].filter((c) => c.attempts.some((a) => a.ok) && c.attempts.some((a) => !a.ok));

// state/apps/<app>/flaky.json: { tests: { "Class.name": { count, firstSeen, lastSeen, slices: [] } } }. Informational
// (D8: flaky tests never block); a test seen in 2+ slices is "persistent".
export function recordFlaky(file, slice, names) {
  const j = readJson(file, { tests: {} });
  j.tests ||= {};
  const now = new Date().toISOString();
  for (const n of names) {
    const t = j.tests[n] || { count: 0, firstSeen: now, slices: [] };
    t.count++; t.lastSeen = now;
    if (slice && !t.slices.includes(slice)) t.slices.push(slice);
    j.tests[n] = t;
  }
  try { writeJson(file, j); } catch { /* informational */ }
  return j;
}

export function testBugReason(text) {
  for (const [re, why] of TEST_BUGS) if (re.test(text)) return why;
  for (const m of text.matchAll(SAME_VALUE)) if (m[1] === m[2]) return `expected and actual both print "${m[1]}" — type mismatch (e.g. int vs long), can never pass`;
  return null;
}

// Spec files that failed in a Vitest run ("FAIL  src/app/x.spec.ts > …" or "❯ src/app/x.spec.ts (3 tests | 1 failed)").
export function vitestFailedFiles(out) {
  const files = new Set();
  for (const m of out.matchAll(/(?:FAIL|❯)\s+(?:frontend\/)?(src\/[\w./-]+?\.spec\.ts)\b/g)) files.add(`frontend/${m[1]}`);
  return [...files];
}

export const javaTestFile = (classname) => `backend/src/test/java/${classname.replace(/\$.*$/, '').replace(/\./g, '/')}.java`;

// input: { appDir, phaseDir, slice, layers: { backend?: {code, out}, frontend?: {code, out} },
//          reportsDir?, since?, changed: [app-relative test files changed/added in the working tree] | null (unknown) }
// returns: { verdict: RED | NOT-RED | WRONG-REASON, layers: [{layer, code, cls, out}], notRed: [..], wrong: [..], sliceTests }
export function analyseRed({ appDir, phaseDir, slice, layers = {}, reportsDir, since = 0, changed = null, compile = null }) {
  const s = (parsePlan(phaseDir) || []).find((p) => p.slice === slice);
  if (!s) return { verdict: 'NOT-RED', layers: [], notRed: [`${slice} is not in the plan`], wrong: [], sliceTests: [] };
  const traces = collectTraces(appDir);
  const specs = parseSpecFrs(phaseDir);
  const sliceTests = s.frs.flatMap((f) => (traces.get(f) || []).map((t) => ({ ...t, fr: f })));
  const notRed = [];
  const wrong = [];
  const flaky = [];
  const compiler = []; // verbatim compiler lines for the evidence
  // Compile first (red-check compiles the backend before running anything): a compile error is never valid RED.
  if (compile && compile.count) { wrong.push(...compileProblems('backend', compile)); compiler.push(...compile.verbatim); }

  for (const f of s.frs.filter((x) => !traces.get(x))) notRed.push(`${f}: no test tagged "@trace ${f}"`);

  // Tests the spec says this slice supersedes must have been updated by the tester.
  const superseded = [...new Set(s.frs.flatMap((f) => (specs.get(f)?.changes || []).flatMap((c) => c.tests)))];
  if (changed) for (const t of superseded) if (!changed.includes(t)) notRed.push(`${t}: the spec supersedes it ("Changes earlier behaviour") but it was not updated`);

  // Ranges/invariants need a parameterized or exhaustive test, not one example.
  for (const f of s.frs) {
    const r = specs.get(f)?.ranges;
    if (!r || /^none\b/i.test(r)) continue;
    const files = (traces.get(f) || []).filter((t) => t.layer !== 'e2e');
    if (!files.some((t) => EXHAUSTIVE.test(readText(path.join(appDir, t.rel)) || ''))) {
      notRed.push(`${f}: spec lists "Ranges & invariants: ${r.slice(0, 60)}" but no unit/integration test tagged ${f} is parameterized or loops over the range`);
    }
  }

  // Files whose failures are expected now: the slice's tagged tests + every test file the tester touched.
  const expected = new Set([...sliceTests.map((t) => t.rel), ...(changed || [])]);
  const testLayers = [...new Set(sliceTests.map((t) => t.layer))].filter((l) => l !== 'e2e');
  const out = [];
  for (const layer of testLayers) {
    const res = layers[layer];
    if (!res) continue;
    let cls;
    if (res.code === 0) { cls = 'PASSED (tests do not fail — not red)'; notRed.push(`${layer}: all tests pass`); }
    else if (COMPILE[layer].test(res.out)) {
      cls = 'COMPILE-ERROR (red for the wrong reason)';
      const d = diagnostics(appDir, [{ layer, stage: 'tests', code: res.code, out: res.out }], changed || []);
      wrong.push(...compileProblems(layer, d));
      compiler.push(...d.verbatim);
    }
    else {
      cls = 'FAIL (assertions / missing behaviour)';
      const bugs = [];
      if (layer === 'backend') {
        const dir = reportsDir || path.join(appDir, 'backend/build/test-results/test');
        const flakyKeys = new Set(flakyCases(junitCases(dir, since)).map((c) => `${c.classname}#${c.name}`));
        const seen = new Set();
        for (const f of junitFailures(dir, since)) {
          const file = javaTestFile(f.classname);
          const key = `${f.classname}#${f.name}`;
          if (seen.has(key)) continue;
          seen.add(key);
          if (flakyKeys.has(key)) { // failed, then passed on retry
            if (expected.has(file)) bugs.push(`${f.classname}.${f.name}: flaky new test — it failed, then passed on retry; new and updated tests must be deterministic`);
            else flaky.push(`${f.classname}.${f.name}`);
            continue;
          }
          const why = testBugReason(f.text);
          if (why) bugs.push(`${f.classname}.${f.name}: ${why}`);
          else if (!expected.has(file) && exists(path.join(appDir, file))) bugs.push(`${f.classname}.${f.name}: an older test fails although no production code changed — the new tests leak state into it (shared rows, static counters, request logs, unfinished async work) or it must be updated under "Changes earlier behaviour"`);
        }
      } else {
        const why = testBugReason(res.out);
        if (why) bugs.push(`frontend: ${why}`);
        for (const file of vitestFailedFiles(res.out)) {
          if (!expected.has(file) && exists(path.join(appDir, file))) bugs.push(`${file}: an older spec fails although no production code changed — test isolation or an unlisted superseded expectation`);
        }
      }
      if (bugs.length) { cls = 'FAIL, but some failures are test bugs (red for the wrong reason)'; wrong.push(...bugs); }
    }
    out.push({ layer, code: res.code, cls, out: res.out });
  }
  if (!testLayers.length && !notRed.length) notRed.push('no unit/integration test layer tagged for the slice');

  const verdict = notRed.length ? 'NOT-RED' : wrong.length ? 'WRONG-REASON' : 'RED';
  return { verdict, layers: out, notRed, wrong, flaky, compiler, sliceTests, untagged: s.frs.filter((x) => !traces.get(x)), frs: s.frs };
}

// red-evidence.md. "Scope:" is an additive line (a file without it was a full run).
export function renderEvidence(a, { slice, frs, scope = 'full' }) {
  return [
    `# Red evidence — ${slice}`,
    '',
    `Date: ${today()} · FRs: ${frs.join(', ')}`,
    `Scope: ${scope}${scope === 'slice' ? ' (related tests only — the slice gate runs the full suite)' : ''}`,
    '',
    '## Tagged tests',
    '',
    ...a.sliceTests.map((t) => `- ${t.fr} → \`${t.rel}\` (${t.layer})`),
    ...(a.untagged || []).map((f) => `- ${f} → MISSING: no test tagged "@trace ${f}"`),
    '',
    ...(a.notRed.length || a.wrong.length ? ['## Problems', '', ...a.notRed.map((p) => `- NOT-RED: ${p}`), ...a.wrong.map((p) => `- WRONG-REASON: ${p}`), ''] : []),
    ...(a.compiler?.length ? ['## Compiler errors', '', ...a.compiler.map((l) => `    ${l}`), ''] : []),
    ...(a.flaky?.length ? ['## Flaky older tests (passed on retry — not blamed on this slice)', '', ...a.flaky.map((f) => `- FLAKY: ${f}`), ''] : []),
    ...a.layers.map((l) => `## ${l.layer}\n\n- Command exit: ${l.code}\n- Classification: ${l.cls}\n\n\`\`\`\n${tail(l.out, 50)}\n\`\`\`\n`),
    `RESULT: ${a.verdict}`,
    '',
  ].join('\n');
}
