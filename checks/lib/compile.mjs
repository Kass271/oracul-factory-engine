// Compile-only runs (no tests) with the compiler's own diagnostics, verbatim, and a label per diagnostic:
//   main · generated · test-new (a test file changed in the working tree) · test-old (an untouched older test) · unknown
// Used by bin/compile-check.mjs (contract sync, old-test listing) and bin/red-check.mjs (compile first).
// Self-test seam: ORACUL_COMPILE_FAKE='{"backend:main":{"code":1,"out":"…"}}' replaces the real commands.
import fs from 'node:fs';
import path from 'node:path';
import { exists, run } from './core.mjs';

// [{ layer, stage, cwd, steps: [[cmd, args]] }] — `tests` needs `main`, so the order matters.
export function compileSteps(appDir, layers = ['backend', 'frontend'], stages = ['main', 'tests']) {
  const out = [];
  if (layers.includes('backend') && exists(path.join(appDir, 'backend'))) {
    if (stages.includes('main')) out.push({ layer: 'backend', stage: 'main', cwd: 'backend', steps: [['./gradlew', ['-q', 'compileJava', '--console=plain']]] });
    if (stages.includes('tests')) out.push({ layer: 'backend', stage: 'tests', cwd: 'backend', steps: [['./gradlew', ['-q', 'compileTestJava', '--console=plain']]] });
  }
  if (layers.includes('frontend') && exists(path.join(appDir, 'frontend'))) {
    const gen = ['npm', ['run', 'generate:api', '--silent']];
    if (stages.includes('main')) out.push({ layer: 'frontend', stage: 'main', cwd: 'frontend', steps: [gen, ['npx', ['tsc', '--noEmit', '--pretty', 'false', '-p', 'tsconfig.app.json']]] });
    if (stages.includes('tests') && exists(path.join(appDir, 'frontend', 'tsconfig.spec.json'))) out.push({ layer: 'frontend', stage: 'tests', cwd: 'frontend', steps: [['npx', ['tsc', '--noEmit', '--pretty', 'false', '-p', 'tsconfig.spec.json']]] });
  }
  return out;
}

// Run the steps; a failing main stage of a layer skips that layer's tests stage. → [{ layer, stage, code, out, skipped? }]
export function runCompile(appDir, steps) {
  const fake = process.env.ORACUL_COMPILE_FAKE ? JSON.parse(process.env.ORACUL_COMPILE_FAKE) : null;
  const res = [];
  for (const s of steps) {
    if (s.stage === 'tests' && res.some((r) => r.layer === s.layer && r.stage === 'main' && r.code !== 0)) { res.push({ layer: s.layer, stage: s.stage, code: 0, out: '', skipped: true }); continue; }
    if (fake) { const f = fake[`${s.layer}:${s.stage}`] || { code: 0, out: '' }; res.push({ layer: s.layer, stage: s.stage, code: f.code, out: f.out }); continue; }
    let code = 0, out = '';
    for (const [cmd, a] of s.steps) {
      const r = run(cmd, a, { cwd: path.join(appDir, s.cwd), env: { ...process.env, CI: 'true' } });
      out += r.out;
      if (r.code !== 0) { code = r.code; break; }
    }
    res.push({ layer: s.layer, stage: s.stage, code, out });
  }
  return res;
}

const DIAG = [
  { re: /^(.+?\.java):(\d+): error: (.*)$/, layer: 'backend' },
  { re: /^(.+?\.ts)\((\d+),\d+\): error (TS\d+: .*)$/, layer: 'frontend' },
  { re: /^(?:(?:ERROR|Error):?\s+)?(.+?\.ts):(\d+):\d+ - error (TS\d+: .*)$/, layer: 'frontend' }, // Angular builder
  { re: /^(\S+?\.ts):(\d+):\d+:()$/, layer: 'frontend' }, // esbuild: "✘ [ERROR] TS2304: …" then "src/app/x.ts:3:5:"
];

export function labelOf(rel, changed = []) {
  if (/(^|\/)build\/generated\//.test(rel) || /^frontend\/src\/app\/api\//.test(rel)) return 'generated';
  if (/^backend\/src\/test\//.test(rel) || /\.spec\.ts$/.test(rel)) return changed.includes(rel) ? 'test-new' : 'test-old';
  if (/^backend\/src\/main\//.test(rel) || /^frontend\/src\//.test(rel)) return 'main';
  return 'unknown';
}

// → { count, labels: { main, generated, 'test-new', 'test-old', unknown }, files: [{ rel, label, line, msg }], verbatim }
export function diagnostics(appDir, results, changed = []) {
  const files = [];
  const verbatim = [];
  for (const r of results.filter((x) => x.code !== 0)) {
    const lines = String(r.out || '').split('\n');
    verbatim.push(`-- ${r.layer} ${r.stage} (exit ${r.code}) --`);
    lines.forEach((l, i) => {
      for (const d of DIAG) {
        const m = l.trim().match(d.re);
        if (!m) continue;
        let p = m[1];
        if (path.isAbsolute(p)) p = path.relative(appDir, p);
        else if (d.layer === 'frontend' && !p.startsWith('frontend/')) p = `frontend/${p}`;
        p = p.split(path.sep).join('/');
        files.push({ rel: p, label: labelOf(p, changed), line: Number(m[2]), msg: m[3] });
        verbatim.push(l.trim(), ...lines.slice(i + 1, i + 3).filter((x) => x.trim() && !DIAG.some((dd) => dd.re.test(x.trim()))).map((x) => `    ${x.trim()}`));
        break;
      }
    });
    if (!files.length && r.out) verbatim.push(...lines.filter((l) => l.trim()).slice(-15)); // unknown format: the tail, as is
  }
  const labels = { main: 0, generated: 0, 'test-new': 0, 'test-old': 0, unknown: 0 };
  for (const f of files) labels[f.label]++;
  return { count: files.length || (results.some((r) => r.code !== 0) ? 1 : 0), labels, files, verbatim: verbatim.slice(0, 60) };
}

export const summaryLine = (d) => `COMPILE ERRORS: ${d.files.length || d.count} (${Object.entries(d.labels).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(' · ') || 'format not recognised — see output'})`;

// The last commit that closed a slice or the setup — the code was green there. null = unknown (no git / none yet).
export function greenBase(appDir) {
  const r = run('git', ['-C', appDir, 'log', '-1', '--format=%H', '-E', '--grep', ': done \\(', '--grep', '00_setup']);
  return r.code === 0 && r.out.trim() ? r.out.trim() : null;
}
// Did api/openapi.yaml change since the green base (committed or not)? Unknown → true (compile to be sure).
export function contractChanged(appDir) {
  const base = greenBase(appDir);
  if (!base) return true;
  return run('git', ['-C', appDir, 'diff', '--quiet', base, '--', 'api/openapi.yaml']).code !== 0;
}

