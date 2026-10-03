// Shared hook plumbing: read the event JSON from stdin, resolve the active app and classify paths.
import fs from 'node:fs';
import path from 'node:path';
import { APPS_DIR, ENGINE, loadActive, loadState } from '../checks/lib/core.mjs';

export function readInput() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { return {}; }
}

export function active() {
  const a = loadActive();
  if (!a?.app) return null;
  const state = loadState(a.app);
  return state ? { app: a.app, appDir: path.join(APPS_DIR, a.app), state } : null;
}

export const inside = (file, dir) => {
  const rel = path.relative(dir, file);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

export const isEngine = (file) => inside(file, ENGINE);

// Classify an app-relative path.
export function kind(rel) {
  if (/^frontend\/src\/app\/api\//.test(rel) || /^backend\/build\//.test(rel)) return 'generated';
  if (/^backend\/src\/test\//.test(rel) || /\.spec\.ts$/.test(rel) || /^e2e\/tests\//.test(rel)) return 'test';
  if (rel === 'api/openapi.yaml') return 'contract';
  if (/^backend\/src\/main\//.test(rel) || /^frontend\/src\//.test(rel)) return 'prod';
  if (/^docs\//.test(rel)) return 'docs';
  return 'other';
}

// exit 2 = block; stderr is shown to the agent.
export function block(msg) {
  process.stderr.write(`[oracul guard] ${msg}\n`);
  process.exit(2);
}
