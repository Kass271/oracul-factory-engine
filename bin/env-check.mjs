#!/usr/bin/env node
// Step 0 environment check. Writes docs/<phase>/00_setup/environment-check.md ("Result: OK" | "Result: FAILED").
//   --write    write the report into the active app/phase (otherwise print only)
// Exit 1 when anything required is missing, with the exact fix for each item.
import fs from 'node:fs';
import path from 'node:path';
import { context, parseArgs, run, today } from '../checks/lib/core.mjs';

const args = parseArgs();
const rows = [];
const add = (item, ok, found, fix = '') => rows.push({ item, ok, found, fix });

const ver = (s) => (s.match(/(\d+)\.(\d+)\.(\d+)/) || []).slice(1).map(Number);
const gte = (a, b) => { for (let i = 0; i < 3; i++) { if ((a[i] ?? 0) !== b[i]) return (a[i] ?? 0) > b[i]; } return true; };
// supports "^22.22.3 || ^24.15.0 || >=26.0.0"
function satisfies(v, range) {
  return range.split('||').map((x) => x.trim()).some((c) => {
    const min = ver(c);
    if (c.startsWith('^')) return v[0] === min[0] && gte(v, min);
    if (c.startsWith('>=')) return gte(v, min);
    return false;
  });
}

// Node: Angular CLI publishes its supported engines; fall back to a known range when offline.
const nodeV = ver(process.version);
let nodeRange = '^22.22.3 || ^24.15.0 || >=26.0.0';
const meta = run('npm', ['view', '@angular/cli@latest', 'engines.node', '--silent']);
if (meta.code === 0 && meta.out.trim()) nodeRange = meta.out.trim();
add('Node.js', satisfies(nodeV, nodeRange), process.version, `install Node.js matching ${nodeRange} (e.g. "brew install node@24" or nvm install 24)`);

const npm = run('npm', ['-v']);
add('npm', npm.code === 0, npm.out.trim(), 'comes with Node.js');

const git = run('git', ['--version']);
add('git', git.code === 0, git.out.trim(), 'install git');

const java = run('java', ['-version']);
const jv = ver(java.out);
add('JDK to run Gradle (≥17)', java.code === 0 && jv[0] >= 17, java.code === 0 ? java.out.split('\n')[0] : 'not found',
  'install a JDK ≥ 17 (sdk install java 25-tem); Java 25 for compiling is downloaded by the Gradle toolchain');
add('Java 25 toolchain', true, jv[0] >= 25 ? 'installed locally' : 'auto-provisioned by Gradle (foojay resolver) on first build', '');

const docker = run('docker', ['info', '--format', '{{.ServerVersion}}']);
add('Docker daemon', docker.code === 0, docker.code === 0 ? `server ${docker.out.trim()}` : 'not running / not installed',
  'start Docker Desktop (open -a Docker) and wait until it is running');

const compose = run('docker', ['compose', 'version', '--short']);
add('Docker Compose v2', compose.code === 0, compose.out.trim() || 'not found', 'update Docker Desktop');

// The backend Dockerfile caches Gradle with RUN --mount (BuildKit, the default builder of current Docker Desktop).
const buildx = run('docker', ['buildx', 'version']);
add('Docker BuildKit (buildx)', buildx.code === 0, buildx.code === 0 ? buildx.out.trim().split('\n')[0] : 'not found', 'update Docker Desktop (BuildKit/buildx is included)');

for (const [name, url] of [['start.spring.io', 'https://start.spring.io/metadata/client'], ['npm registry', 'https://registry.npmjs.org/']]) {
  const r = run('curl', ['-s', '-o', '/dev/null', '-m', '10', '-w', '%{http_code}', url]);
  add(`network: ${name}`, r.out.trim().startsWith('2'), `HTTP ${r.out.trim() || 'error'}`, 'check internet / proxy');
}

const ok = rows.every((r) => r.ok);
const md = [
  `# Environment check`,
  '',
  `Date: ${today()} · Host: ${process.platform} ${process.arch}`,
  '',
  '| Item | Status | Found | Fix |',
  '|---|---|---|---|',
  ...rows.map((r) => `| ${r.item} | ${r.ok ? 'OK' : 'MISSING'} | ${r.found} | ${r.ok ? '' : r.fix} |`),
  '',
  `Result: ${ok ? 'OK' : 'FAILED'}`,
  '',
].join('\n');

console.log(md);
if (args.write) {
  const ctx = context(args);
  if (!ctx.phaseDir) { console.error('env-check: no active app/phase to write into'); process.exit(1); }
  const out = path.join(ctx.phaseDir, '00_setup', 'environment-check.md');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, md);
  console.log(`written: ${path.relative(ctx.appDir, out)}`);
}
process.exit(ok ? 0 : 1);
