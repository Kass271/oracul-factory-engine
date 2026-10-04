// The app's Docker stack modes: .oracul/stack.json, written by the analyst when an FR changes how the stack starts
// (e.g. a stub that is opt-in through docker-compose.e2e.yml). Without it, stack.mjs runs plain `docker compose` —
// unless extra compose files exist, then it refuses instead of guessing which stack E2E would hit.
//   { "project": "<name>",                                    optional (default: compose "name:" or folder name)
//     "modes": { "e2e": { "files": ["docker-compose.yml", "docker-compose.e2e.yml"], "profiles": ["stub"] },
//                "run": { "files": ["docker-compose.yml"] } },  e2e required; run optional (default: e2e)
//     "urls": { "frontend": "http://localhost:4200", "health": "http://localhost:8080/actuator/health" } }   optional
import fs from 'node:fs';
import path from 'node:path';
import { exists, readText } from './core.mjs';

export const STACK_CONFIG = '.oracul/stack.json';
export const MODES = ['e2e', 'run'];
const BASE = new Set(['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']);

// Compose files besides the base file — docker compose merges docker-compose.override.yml on its own.
export const extraComposeFiles = (appDir) => (exists(appDir) ? fs.readdirSync(appDir) : [])
  .filter((f) => /^(docker-)?compose(\.[\w-]+)?\.ya?ml$/.test(f) && !BASE.has(f)).sort();

// → { config: null | object, problems: [] }
export function loadStackConfig(appDir) {
  const p = path.join(appDir, STACK_CONFIG);
  if (!exists(p)) return { config: null, problems: [] };
  let c;
  try { c = JSON.parse(readText(p)); } catch (e) { return { config: null, problems: [`${STACK_CONFIG} is not valid JSON (${e.message})`] }; }
  const problems = [];
  if (!c || typeof c !== 'object' || !c.modes || typeof c.modes !== 'object') problems.push(`${STACK_CONFIG}: "modes" missing`);
  else {
    if (!c.modes.e2e) problems.push(`${STACK_CONFIG}: modes.e2e missing (the stack the factory's E2E runs against)`);
    for (const [m, v] of Object.entries(c.modes)) {
      if (!MODES.includes(m)) { problems.push(`${STACK_CONFIG}: unknown mode "${m}" (e2e | run)`); continue; }
      if (!Array.isArray(v.files) || !v.files.length) problems.push(`${STACK_CONFIG}: modes.${m}.files must list at least one compose file`);
      for (const f of v.files || []) if (!exists(path.join(appDir, f))) problems.push(`${STACK_CONFIG}: modes.${m} file ${f} does not exist`);
      if (v.profiles !== undefined && (!Array.isArray(v.profiles) || v.profiles.some((x) => typeof x !== 'string'))) problems.push(`${STACK_CONFIG}: modes.${m}.profiles must be a list of names`);
    }
  }
  if (c?.project !== undefined && !/^[a-z0-9][a-z0-9_-]*$/.test(String(c.project))) problems.push(`${STACK_CONFIG}: project must be a lowercase compose project name`);
  return { config: problems.length ? null : c, problems };
}

export function projectName(appDir, config) {
  if (config?.project) return config.project;
  const n = (readText(path.join(appDir, 'docker-compose.yml')) || '').match(/^name:\s*["']?([\w-]+)/m);
  return n ? n[1] : path.basename(appDir).toLowerCase().replace(/[^a-z0-9_-]/g, '');
}

// Arguments before the compose subcommand. down covers every mode (files + profiles), so nothing is left running.
export function composeArgs(config, action, mode = 'e2e') {
  if (!config) return [];
  const sets = action === 'down' ? Object.values(config.modes) : [config.modes[mode] || config.modes.e2e];
  const files = [...new Set(sets.flatMap((s) => s.files || []))];
  const profiles = [...new Set(sets.flatMap((s) => s.profiles || []))];
  return [...(config.project ? ['-p', config.project] : []), ...files.flatMap((f) => ['-f', f]), ...profiles.flatMap((p) => ['--profile', p])];
}
