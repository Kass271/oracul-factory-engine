// Line coverage of the reports on disk (backend JaCoCo XML, frontend coverage-summary.json or lcov.info).
import fs from 'node:fs';
import path from 'node:path';
import { readJson, readText } from './core.mjs';

export function coverageOf(appDir, layer) {
  const ctx = { appDir };
  function backend() {
  const xml = readText(path.join(ctx.appDir, 'backend/build/reports/jacoco/test/jacocoTestReport.xml'));
  if (xml === null) return null;
  const all = [...xml.matchAll(/<counter type="LINE" missed="(\d+)" covered="(\d+)"\/>/g)];
  if (!all.length) return null;
  const [, missed, covered] = all.at(-1); // report-level counter is the last one
  const total = Number(missed) + Number(covered);
  return total ? (Number(covered) / total) * 100 : 0;
}

  function frontend() {
  const dir = path.join(ctx.appDir, 'frontend/coverage');
  const summary = fs.existsSync(dir) ? findDeep(dir, 'coverage-summary.json') : null;
  if (summary) return readJson(summary)?.total?.lines?.pct ?? null;
  const lcov = fs.existsSync(dir) ? findDeep(dir, 'lcov.info') : null;
  if (!lcov) return null;
  let lf = 0, lh = 0;
  for (const m of readText(lcov).matchAll(/^L([FH]):(\d+)/gm)) m[1] === 'F' ? (lf += +m[2]) : (lh += +m[2]);
  return lf ? (lh / lf) * 100 : 0;
}

  function findDeep(dir, name) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name === name) return p;
    if (e.isDirectory()) { const f = findDeep(p, name); if (f) return f; }
  }
  return null;
}

  return layer === 'backend' ? backend() : frontend();
}
