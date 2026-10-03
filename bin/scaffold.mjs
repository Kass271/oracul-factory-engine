#!/usr/bin/env node
// Step 0 scaffolding — deterministic, no AI. Builds the app skeleton for the ACTIVE app/phase:
//   backend   Spring Initializr (Gradle Kotlin, Java 25, latest Boot) + templates/app/backend overlay
//   frontend  Angular CLI (latest) + Angular Material + ng-openapi-gen + templates/app/frontend overlay
//   e2e       Playwright + templates/app/e2e overlay
//   root      api/openapi.yaml, docker-compose.yml, .gitignore, local git repo, ADR with pinned versions
// Phase 02+: run with --next-phase (no scaffolding; ADR note pointing at phase 01).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ENGINE, context, listPhases, parseArgs, readJson, readText, run, today, writeJson } from '../checks/lib/core.mjs';

const args = parseArgs();
const ctx = context(args);
if (!ctx.appDir || !ctx.phaseDir) fail('no active app/phase — run state.mjs init <app> and state.mjs phase new <name> first');
const APP = ctx.app;
const TITLE = ctx.state?.title || APP;
const T = path.join(ENGINE, 'templates');
const vars = { APP_NAME: APP, APP_TITLE: TITLE, PHASE: ctx.phase, DATE: today() };

function fail(m) { console.error(`scaffold: ${m}`); process.exit(1); }
function step(m) { console.log(`\n▶ ${m}`); }
function sh(cmd, cmdArgs, cwd = ctx.appDir, quiet = true) {
  const r = run(cmd, cmdArgs, { cwd, env: { ...process.env, CI: 'true', NG_CLI_ANALYTICS: 'false' } });
  if (r.code !== 0) fail(`${cmd} ${cmdArgs.join(' ')} failed (exit ${r.code})\n${r.out.slice(-4000)}`);
  if (!quiet) console.log(r.out.trim());
  return r.out;
}
const fill = (s) => s.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (vars[k] ?? m));
function overlay(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const e of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const s = path.join(srcDir, e.name);
    const d = path.join(destDir, e.name === 'gitignore' ? '.gitignore' : e.name);
    if (e.isDirectory()) { fs.mkdirSync(d, { recursive: true }); overlay(s, d); }
    else fs.writeFileSync(d, fill(fs.readFileSync(s, 'utf8')));
  }
}
const npmLatest = (pkg) => sh('npm', ['view', `${pkg}@latest`, 'version', '--silent'], os.tmpdir()).trim();

// ---------------------------------------------------------------- phase 02+
if (args['next-phase']) {
  const first = listPhases(ctx.appDir)[0];
  const adr = path.join(ctx.phaseDir, '00_setup', 'adr-001-stack.md');
  fs.writeFileSync(adr, `# ADR-001 — Technology stack\n\nDate: ${today()} · Status: unchanged\n\nThe stack (Java 25, Spring Boot, Gradle, Angular + Material, PostgreSQL, Docker) is unchanged.\nSee [${first} ADR](../../${first}/00_setup/adr-001-stack.md).\n`);
  console.log(`ADR note written for ${ctx.phase}`);
  process.exit(0);
}

// ---------------------------------------------------------------- phase 01
const existing = fs.existsSync(ctx.appDir) ? fs.readdirSync(ctx.appDir).filter((f) => !['docs', '.git', '.DS_Store'].includes(f)) : [];
if (existing.length) fail(`${ctx.appDir} already has ${existing.join(', ')} — scaffolding is for greenfield apps only`);

step('git repository (local only, no remote)');
if (!fs.existsSync(path.join(ctx.appDir, '.git'))) sh('git', ['init', '-q', '-b', 'main']);

step('backend: Spring Initializr (Gradle Kotlin DSL, Java 25)');
const metaRaw = sh('curl', ['-sf', '-H', 'Accept: application/json', 'https://start.spring.io/metadata/client'], os.tmpdir());
const bootVersion = JSON.parse(metaRaw).bootVersion.default.replace(/\.RELEASE$/, '');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oracul-'));
sh('curl', ['-sf', 'https://start.spring.io/starter.zip', '-o', path.join(tmp, 'b.zip'),
  '-d', 'type=gradle-project-kotlin', '-d', 'language=java', '-d', 'javaVersion=25', '-d', `bootVersion=${bootVersion}`,
  '-d', 'groupId=com.oracul', '-d', 'artifactId=backend', '-d', 'name=backend', '-d', 'packageName=com.oracul.app',
  '-d', 'dependencies=web,validation,data-jpa,flyway,postgresql,actuator,testcontainers'], tmp);
sh('unzip', ['-q', path.join(tmp, 'b.zip'), '-d', path.join(ctx.appDir, 'backend')]);
const initBuild = readText(path.join(ctx.appDir, 'backend', 'build.gradle.kts'));
const deps = (initBuild.match(/dependencies \{\n([\s\S]*?)\n\}/) || [])[1];
if (!deps) fail('could not read dependencies from the Initializr build file');
Object.assign(vars, {
  BOOT_VERSION: bootVersion,
  DEP_MGMT_VERSION: initBuild.match(/io\.spring\.dependency-management"\) version "([^"]+)"/)[1],
  DEPENDENCIES: deps.split('\n').map((l) => `    ${l.trim()}`).join('\n'),
  OPENAPI_GEN_VERSION: latestGradlePlugin('org.openapi.generator', '7.25.0'),
  FOOJAY_VERSION: latestGradlePlugin('org.gradle.toolchains.foojay-resolver-convention', '1.0.0'),
  GRADLE_VERSION: (readText(path.join(ctx.appDir, 'backend/gradle/wrapper/gradle-wrapper.properties')).match(/gradle-([\d.]+)-bin/) || [])[1],
});
fs.rmSync(path.join(ctx.appDir, 'backend', 'HELP.md'), { force: true });
overlay(path.join(T, 'app', 'backend'), path.join(ctx.appDir, 'backend'));

function latestGradlePlugin(id, fallback) {
  const r = run('curl', ['-sf', `https://plugins.gradle.org/m2/${id.replace(/\./g, '/')}/${id}.gradle.plugin/maven-metadata.xml`]);
  return (r.out.match(/<release>([^<]+)<\/release>/) || [])[1] || fallback;
}

step('root files: api/openapi.yaml, docker-compose.yml, .gitignore');
overlay(path.join(T, 'app', 'api'), path.join(ctx.appDir, 'api'));
fs.writeFileSync(path.join(ctx.appDir, 'docker-compose.yml'), fill(readText(path.join(T, 'app', 'docker-compose.yml'))));
fs.writeFileSync(path.join(ctx.appDir, '.gitignore'), readText(path.join(T, 'app', 'gitignore')));

step('frontend: Angular CLI + Angular Material');
vars.ANGULAR_VERSION = npmLatest('@angular/cli');
sh('npx', ['-y', `@angular/cli@${vars.ANGULAR_VERSION}`, 'new', 'frontend', '--directory', 'frontend', '--routing', '--style', 'scss',
  '--ssr=false', '--skip-git', '--defaults', '--package-manager', 'npm']);
const FE = path.join(ctx.appDir, 'frontend');
vars.MATERIAL_VERSION = npmLatest('@angular/material');
sh('npx', ['ng', 'add', `@angular/material@${vars.MATERIAL_VERSION}`, '--skip-confirmation', '--defaults'], FE);
vars.NG_OPENAPI_GEN_VERSION = npmLatest('ng-openapi-gen');
const vitest = readJson(path.join(FE, 'node_modules', 'vitest', 'package.json'))?.version;
sh('npm', ['i', '-D', '--no-audit', '--no-fund', `ng-openapi-gen@${vars.NG_OPENAPI_GEN_VERSION}`, ...(vitest ? [`@vitest/coverage-v8@${vitest}`] : []), 'prettier'], FE);
overlay(path.join(T, 'app', 'frontend'), FE);

const pkgPath = path.join(FE, 'package.json');
const pkg = readJson(pkgPath);
Object.assign(pkg.scripts, {
  'generate:api': 'ng-openapi-gen --config ng-openapi-gen.json',
  prestart: 'npm run generate:api',
  prebuild: 'npm run generate:api',
  pretest: 'npm run generate:api',
  'pretest:ci': 'npm run generate:api',
  'test:ci': 'ng test --watch=false --coverage',
  format: 'prettier --write "src/**/*.{ts,html,scss}"',
});
writeJson(pkgPath, pkg);

const ngPath = path.join(FE, 'angular.json');
const ng = readJson(ngPath);
const project = ng.projects[Object.keys(ng.projects)[0]];
project.architect.serve.options = { ...(project.architect.serve.options || {}), proxyConfig: 'proxy.conf.json' };
project.architect.test.options = {
  ...(project.architect.test.options || {}),
  coverageReporters: ['json-summary', 'lcov', 'text-summary'],
  coverageExclude: ['src/app/api/**'],
};
writeJson(ngPath, ng);
sh('npm', ['run', 'generate:api', '--silent'], FE);

step('e2e: Playwright');
overlay(path.join(T, 'app', 'e2e'), path.join(ctx.appDir, 'e2e'));
const E2E = path.join(ctx.appDir, 'e2e');
sh('npm', ['i', '-D', '--no-audit', '--no-fund', '@playwright/test', '@types/node'], E2E);
vars.PLAYWRIGHT_VERSION = readJson(path.join(E2E, 'node_modules', '@playwright', 'test', 'package.json'))?.version;
sh('npx', ['playwright', 'install', 'chromium'], E2E);

step('ADR-001 with pinned versions');
fs.writeFileSync(path.join(ctx.phaseDir, '00_setup', 'adr-001-stack.md'), fill(readText(path.join(T, 'docs', 'adr-001-stack.md'))));

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\nscaffold done:', JSON.stringify({
  boot: vars.BOOT_VERSION, gradle: vars.GRADLE_VERSION, angular: vars.ANGULAR_VERSION, material: vars.MATERIAL_VERSION,
  openapiGenerator: vars.OPENAPI_GEN_VERSION, ngOpenapiGen: vars.NG_OPENAPI_GEN_VERSION, playwright: vars.PLAYWRIGHT_VERSION,
}));
