// "Related tests" of a slice — what the development loop runs instead of the whole suite (red-check --scope slice,
// verify --related, builder loops). The slice gate (full verify + full E2E) still runs everything.
// Related = the tests tagged "@trace" with the slice's FRs + the tests its spec supersedes ("Changes earlier behaviour")
//         + test files changed in the working tree + test files that failed in the previous run.
import path from 'node:path';
import fs from 'node:fs';
import { exists, readJson, run } from './core.mjs';
import { collectTraces, parsePlan, parseSpecFrs, testFiles, testLayer } from './docs.mjs';

// Every changed file in the working tree (app-relative), or [] without git.
export function changedFiles(appDir) {
  const g = run('git', ['-C', appDir, 'status', '--porcelain', '--untracked-files=all']);
  return g.code === 0 ? g.out.split('\n').filter(Boolean).map((l) => l.slice(3).replace(/^.* -> /, '').replace(/^"|"$/g, '')) : [];
}
// A changed doc (README.md, docs/…) relates to every test file that names it (G8: doc checks are plain tests).
export function testsNamingDocs(appDir, docs) {
  if (!docs.length) return [];
  const names = [...new Set(docs.map((d) => path.basename(d)))];
  return testFiles(appDir).filter((f) => { try { const t = fs.readFileSync(f.abs, 'utf8'); return names.some((n) => t.includes(n)); } catch { return false; } }).map((f) => f.rel);
}

// backend/src/test/java/com/x/FooIT.java → com.x.FooIT (null for anything else)
export const javaClass = (rel) => (rel.match(/^backend\/src\/test\/java\/(.+)\.java$/) || [])[1]?.replace(/\//g, '.') ?? null;

// → { backend: [rel], frontend: [rel], e2e: [rel] } (app-relative paths of files that exist), or null if the slice is unknown.
export function relatedTests({ appDir, phaseDir, slice, changed = [], failed = [] }) {
  const s = (parsePlan(phaseDir) || []).find((p) => p.slice === slice);
  if (!s) return null;
  const traces = collectTraces(appDir);
  const specs = parseSpecFrs(phaseDir);
  const docs = (changed || []).filter((f) => /^docs\//.test(f) || /\.md$/i.test(f));
  const files = new Set([
    ...testsNamingDocs(appDir, docs),
    ...s.frs.flatMap((f) => (traces.get(f) || []).map((t) => t.rel)),
    ...s.frs.flatMap((f) => (specs.get(f)?.changes || []).flatMap((c) => c.tests)),
    ...(changed || []),
    ...(failed || []),
  ]);
  const out = { backend: [], frontend: [], e2e: [] };
  for (const rel of [...files].sort()) {
    const layer = testLayer(rel);
    if (layer && exists(path.join(appDir, rel))) out[layer].push(rel);
  }
  return out;
}

// Can the frontend runner take a file filter? The scaffolded `test:ci` is `ng test …` (Angular unit-test builder,
// option --include). Anything else runs in full.
export function frontendFilterSupported(appDir) {
  const script = readJson(path.join(appDir, 'frontend', 'package.json'))?.scripts?.['test:ci'] || '';
  return /^\s*ng\s+test\b/.test(script);
}

// The command of one test layer. files = null → the whole layer.
// → { cmd, args, scoped, note }   (scoped false + note when a filter was asked for but cannot be applied)
export function layerCommand(layer, appDir, files = null, { gradleTasks = ['test'], extraGradle = ['--console=plain', '--continue'] } = {}) {
  if (layer === 'backend') {
    const classes = (files || []).map(javaClass).filter(Boolean);
    const filter = files ? classes.flatMap((c) => ['--tests', c]) : [];
    // A task option belongs to the task right before it: --tests must follow `test`, never another task
    // (`test jacocoTestReport --tests X` makes Gradle reject --tests for jacocoTestReport).
    const tasks = gradleTasks.flatMap((t) => (t === 'test' ? ['test', ...filter] : [t]));
    return { cmd: './gradlew', args: [...tasks, ...extraGradle], scoped: !!files && classes.length > 0, note: files && !classes.length ? 'no related backend test class — whole layer' : '' };
  }
  const base = ['run', 'test:ci', '--silent'];
  if (!files) return { cmd: 'npm', args: base, scoped: false, note: '' };
  if (!files.length) return { cmd: 'npm', args: base, scoped: false, note: 'no related frontend spec — whole layer' };
  if (!frontendFilterSupported(appDir)) return { cmd: 'npm', args: base, scoped: false, note: 'frontend test:ci is not `ng test` — no file filter, whole layer (fast)' };
  const include = files.map((f) => path.relative('frontend', f)).flatMap((f) => ['--include', f]);
  return { cmd: 'npm', args: [...base, '--', ...include], scoped: true, note: '' };
}

// Gradle CLI sanity: every --tests directly follows the `test` task or another --tests pair.
export function gradleFilterValid(args) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--tests') continue;
    let j = i - 1;
    while (j >= 1 && args[j - 1] === '--tests') j -= 2;
    if (args[j] !== 'test') return false;
  }
  return true;
}

// Older tests that failed in a full run, rerun on their own: still failing → FALLOUT (a production or contract change
// broke them, or they are outdated); passing alone → LEAK (other tests leak state into them). Pure: the caller runs.
// failedBefore / failedAlone: app-relative test files.
export function isolationVerdicts(failedBefore, failedAlone) {
  const alone = new Set(failedAlone);
  return {
    fallout: failedBefore.filter((f) => alone.has(f)),
    leak: failedBefore.filter((f) => !alone.has(f)),
  };
}
export const FALLOUT_MEANS = 'fails on its own: a production or contract change broke it — if this slice\'s spec changes that behaviour the test is outdated (tester; list it under "Changes earlier behaviour"), otherwise the code broke it (builders)';
export const LEAK_MEANS = 'passes on its own: other tests leak state into it (shared rows, static counters, unfinished async work) — tester';
