// "Related tests" of a slice — what the development loop runs instead of the whole suite (red-check --scope slice,
// verify --related, builder loops). The slice gate (full verify + full E2E) still runs everything.
// Related = the tests tagged "@trace" with the slice's FRs + the tests its spec supersedes ("Changes earlier behaviour")
//         + test files changed in the working tree + test files that failed in the previous run.
import path from 'node:path';
import { exists, readJson } from './core.mjs';
import { collectTraces, parsePlan, parseSpecFrs, testLayer } from './docs.mjs';

// backend/src/test/java/com/x/FooIT.java → com.x.FooIT (null for anything else)
export const javaClass = (rel) => (rel.match(/^backend\/src\/test\/java\/(.+)\.java$/) || [])[1]?.replace(/\//g, '.') ?? null;

// → { backend: [rel], frontend: [rel], e2e: [rel] } (app-relative paths of files that exist), or null if the slice is unknown.
export function relatedTests({ appDir, phaseDir, slice, changed = [], failed = [] }) {
  const s = (parsePlan(phaseDir) || []).find((p) => p.slice === slice);
  if (!s) return null;
  const traces = collectTraces(appDir);
  const specs = parseSpecFrs(phaseDir);
  const files = new Set([
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
    return { cmd: './gradlew', args: [...gradleTasks, ...extraGradle, ...filter], scoped: !!files && classes.length > 0, note: files && !classes.length ? 'no related backend test class — whole layer' : '' };
  }
  const base = ['run', 'test:ci', '--silent'];
  if (!files) return { cmd: 'npm', args: base, scoped: false, note: '' };
  if (!files.length) return { cmd: 'npm', args: base, scoped: false, note: 'no related frontend spec — whole layer' };
  if (!frontendFilterSupported(appDir)) return { cmd: 'npm', args: base, scoped: false, note: 'frontend test:ci is not `ng test` — no file filter, whole layer (fast)' };
  const include = files.map((f) => path.relative('frontend', f)).flatMap((f) => ['--include', f]);
  return { cmd: 'npm', args: [...base, '--', ...include], scoped: true, note: '' };
}
