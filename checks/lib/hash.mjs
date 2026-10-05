// Content hashes of what the Docker images and the E2E run are built from — used to skip a rebuild when nothing went
// into the images changed (stack.mjs up), and to prove the last full E2E run tested the current code (check-e2e-fresh).
// Fail-safe by design: everything in the app counts, minus an explicit exclude list of things that never reach an
// image. A file nobody thought of is included → a rebuild / a new E2E run, never a stale result.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SKIP_DIRS = new Set(['.git', 'node_modules', '.angular', '.gradle', 'build', 'dist', 'coverage', 'target', '.idea', '.vscode']);
// Documented, always excluded from the image inputs (never in an image, or never part of its behaviour): docs, the E2E
// package, tests, specs and every Markdown file (README etc. — a docs edit must never trigger a rebuild or an E2E run).
const IMAGE_EXCLUDE = [/^docs\//, /^e2e\//, /^backend\/src\/test\//, /\.spec\.ts$/, /\.md$/i, /(^|\/)\.DS_Store$/];

// .dockerignore → matcher (the subset the factory supports: `name`, `dir/`, `*.ext`, `**/x`, `a/**/b`, leading `/`,
// `!negation`; the last matching pattern wins, a matching directory covers everything below it). A pattern this
// parser does not understand excludes nothing — the file then counts and causes a rebuild, never a stale image.
export function dockerignoreMatcher(text) {
  const rules = [];
  for (let line of String(text || '').split('\n')) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    const neg = line.startsWith('!');
    let pat = (neg ? line.slice(1) : line).trim().replace(/^\/+/, '').replace(/\/+$/, '');
    if (!pat || /[[\]{}]/.test(pat)) continue; // character classes / braces: unsupported → ignored (fail-safe)
    let re = '';
    for (let i = 0; i < pat.length; i++) {
      const c = pat[i];
      if (c === '*' && pat[i + 1] === '*') { re += pat[i + 2] === '/' ? '(?:.*/)?' : '.*'; i += pat[i + 2] === '/' ? 2 : 1; }
      else if (c === '*') re += '[^/]*';
      else if (c === '?') re += '[^/]';
      else re += c.replace(/[.+^${}()|\\]/g, '\\$&');
    }
    rules.push({ neg, re: new RegExp(`^${re}(?:/.*)?$`) });
  }
  return (rel) => { let ex = false; for (const r of rules) if (r.re.test(rel)) ex = !r.neg; return ex; };
}
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
export const imageExcluded = (appDir) => {
  const ignored = dockerignoreMatcher(fs.existsSync(path.join(appDir, '.dockerignore')) ? fs.readFileSync(path.join(appDir, '.dockerignore'), 'utf8') : '');
  return (rel) => IMAGE_EXCLUDE.some((re) => re.test(rel)) || ignored(rel);
};
export const imageInputsHash = (appDir) => { const ex = imageExcluded(appDir); return hashOf(appDir, files(appDir).filter((r) => !ex(r))); };
// The E2E package itself (tests, config) — not its reports.
export const e2eTestsHash = (appDir) => hashOf(appDir, files(appDir, 'e2e').filter((r) => !E2E_EXCLUDE.some((re) => re.test(r))));
// What a full E2E run tested: the images + the E2E package.
export const e2eInputsHash = (appDir) => `${imageInputsHash(appDir)}:${e2eTestsHash(appDir)}`;
