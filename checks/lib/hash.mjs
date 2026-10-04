// Content hashes of what the Docker images and the E2E run are built from — used to skip a rebuild when nothing went
// into the images changed (stack.mjs up), and to prove the last full E2E run tested the current code (check-e2e-fresh).
// Fail-safe by design: everything in the app counts, minus an explicit exclude list of things that never reach an
// image. A file nobody thought of is included → a rebuild / a new E2E run, never a stale result.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SKIP_DIRS = new Set(['.git', 'node_modules', '.angular', '.gradle', 'build', 'dist', 'coverage', 'target', '.idea', '.vscode']);
// app-relative prefixes that never reach an image
const IMAGE_EXCLUDE = [/^docs\//, /^e2e\//, /^backend\/src\/test\//, /\.spec\.ts$/, /(^|\/)\.DS_Store$/];
const E2E_EXCLUDE = [/^e2e\/(report|test-results)[^/]*\//, /^e2e\/playwright-report\//, /(^|\/)\.DS_Store$/];

function files(dir, rel = '') {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) out.push(...files(dir, r)); }
    else if (e.isFile()) out.push(r);
  }
  return out;
}

function hashOf(appDir, list) {
  const h = crypto.createHash('sha256');
  for (const r of list.sort()) { h.update(r); h.update('\0'); h.update(fs.readFileSync(path.join(appDir, r))); h.update('\0'); }
  return h.digest('hex').slice(0, 32);
}

// Everything the images are built from (Dockerfiles, compose, api, production code, build files, config).
export const imageInputsHash = (appDir) => hashOf(appDir, files(appDir).filter((r) => !IMAGE_EXCLUDE.some((re) => re.test(r))));
// The E2E package itself (tests, config) — not its reports.
export const e2eTestsHash = (appDir) => hashOf(appDir, files(appDir, 'e2e').filter((r) => !E2E_EXCLUDE.some((re) => re.test(r))));
// What a full E2E run tested: the images + the E2E package.
export const e2eInputsHash = (appDir) => `${imageInputsHash(appDir)}:${e2eTestsHash(appDir)}`;
