#!/usr/bin/env node
// One-time migrations of an EXISTING app to what the current engine scaffolds for new apps. Deterministic, idempotent,
// only between slices (subStep none). Each item patches only text it knows; a customised file is refused — printed with
// the manual change and recorded in state/apps/<app>/migrations.json, so --check does not ask again.
//   (no flag) | --speed   apply the pending items (all sets | the speed set)
//   --check               exit 10 when an item is pending (not applied, not refused before), else 0 — changes nothing
//   --dry-run             print what would change, change nothing
// The orchestrator runs `--check` at every slice boundary; on 10 it applies, runs verify and commits.
// Exit: 0 done (applied and/or refused) · 1 refused to run (no app, mid-slice) · 10 pending (--check only)
import fs from 'node:fs';
import path from 'node:path';
import { ENGINE, context, exists, migrationsPath, parseArgs, readJson, readText, run, writeJson } from '../checks/lib/core.mjs';
import { scratchSupported } from '../checks/lib/e2e.mjs';

const args = parseArgs();
const ctx = context(args);
const T = path.join(ENGINE, 'templates', 'app');
const at = (rel) => path.join(ctx.appDir, rel);

// The backend Dockerfile every app scaffolded before the cached layout got (byte for byte).
const OLD_DOCKERFILE = `# build context = app root (needs api/openapi.yaml)
FROM eclipse-temurin:25-jdk AS build
WORKDIR /src
COPY api ./api
COPY backend ./backend
WORKDIR /src/backend
RUN ./gradlew bootJar --no-daemon -q

FROM eclipse-temurin:25-jre
WORKDIR /app
COPY --from=build /src/backend/build/libs/*.jar app.jar
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
`;
const OLD_TEST_BLOCK = 'tasks.withType<Test> {\n    useJUnitPlatform()\n    finalizedBy(tasks.jacocoTestReport)\n}';
const NEW_TEST_BLOCK = 'tasks.withType<Test> {\n    useJUnitPlatform()\n    finalizedBy(tasks.jacocoTestReport)\n    // Oracul: a test that fails once and passes on the retry is reported FLAKY (recorded, never blocking);\n    // a test that fails on both attempts fails the build.\n    retry {\n        maxRetries.set(1)\n        failOnPassedAfterRetry.set(false)\n    }\n}';
const retryVersion = () => process.env.ORACUL_TEST_RETRY_VERSION || (run('curl', ['-sf', '-m', '10', 'https://plugins.gradle.org/m2/org/gradle/test-retry/org.gradle.test-retry.gradle.plugin/maven-metadata.xml']).out.match(/<release>([^<]+)<\/release>/) || [])[1] || '1.6.2';

// item: { id, set, what, pending(): bool, apply(): string | { refused: string } }
const ITEMS = [
  {
    id: 'dockerignore', set: 'speed', what: '.dockerignore (small build context; tests/docs/e2e never invalidate images)',
    pending: () => !exists(at('.dockerignore')),
    apply: () => { fs.writeFileSync(at('.dockerignore'), readText(path.join(T, 'dockerignore'))); return 'written'; },
  },
  {
    id: 'backend-dockerfile', set: 'speed', what: 'backend/Dockerfile with a cached Gradle layer and src/main only',
    pending: () => exists(at('backend/Dockerfile')) && readText(at('backend/Dockerfile')) !== readText(path.join(T, 'backend/Dockerfile')),
    apply: () => {
      if (readText(at('backend/Dockerfile')) !== OLD_DOCKERFILE) return { refused: `backend/Dockerfile was customised — apply the layout of ${path.join(T, 'backend/Dockerfile')} by hand (wrapper + build files first, RUN --mount=type=cache,target=/root/.gradle, COPY backend/src/main only)` };
      fs.writeFileSync(at('backend/Dockerfile'), readText(path.join(T, 'backend/Dockerfile')));
      return 'replaced';
    },
  },
  {
    id: 'test-retry', set: 'speed', what: 'Gradle test-retry plugin (1 retry → FLAKY, never blocking)',
    pending: () => exists(at('backend/build.gradle.kts')) && !/org\.gradle\.test-retry/.test(readText(at('backend/build.gradle.kts'))),
    apply: () => {
      const t = readText(at('backend/build.gradle.kts'));
      const plugin = t.match(/^(\s*)id\("org\.openapi\.generator"\) version "[^"]+"\s*$/m);
      if (!plugin || !t.includes(OLD_TEST_BLOCK)) return { refused: `backend/build.gradle.kts was customised — add id("org.gradle.test-retry") version "<latest>" to plugins and retry { maxRetries.set(1); failOnPassedAfterRetry.set(false) } to tasks.withType<Test>` };
      const next = t.replace(plugin[0], `${plugin[0]}\n${plugin[1]}id("org.gradle.test-retry") version "${retryVersion()}"`).replace(OLD_TEST_BLOCK, NEW_TEST_BLOCK);
      fs.writeFileSync(at('backend/build.gradle.kts'), next);
      return 'patched';
    },
  },
  {
    id: 'playwright-report-dirs', set: 'speed', what: 'e2e/playwright.config.ts reads E2E_REPORT_DIR / E2E_OUTPUT_DIR (scratch + focus runs)',
    pending: () => exists(at('e2e/playwright.config.ts')) && !scratchSupported(readText(at('e2e/playwright.config.ts'))),
    apply: () => {
      const t = readText(at('e2e/playwright.config.ts'));
      const ok = t.includes("'report/results.json'") && t.includes("'report/junit.xml'") && /^export default defineConfig\(\{\s*$/m.test(t)
        && /^\s*testDir:.*$/m.test(t) && !/\boutputDir\s*:/.test(t) && !/\breportDir\b/.test(t);
      if (!ok) return { refused: 'e2e/playwright.config.ts was customised — read E2E_REPORT_DIR (default "report") for the json/junit reporter files and E2E_OUTPUT_DIR (default "test-results") as outputDir, like the current template' };
      const next = t
        .replace(/^export default defineConfig\(\{\s*$/m, "// Official runs use report/ and test-results/; scratch and focus runs set E2E_REPORT_DIR and E2E_OUTPUT_DIR so they never\n// overwrite the official report or traces (added by migrate.mjs).\nconst reportDir = process.env.E2E_REPORT_DIR ?? 'report';\n\nexport default defineConfig({")
        .replace(/^(\s*)(testDir:.*)$/m, "$1$2\n$1outputDir: process.env.E2E_OUTPUT_DIR ?? 'test-results',")
        .replace("'report/results.json'", '`${reportDir}/results.json`')
        .replace("'report/junit.xml'", '`${reportDir}/junit.xml`');
      if (!scratchSupported(next)) return { refused: 'patch did not produce E2E_REPORT_DIR/E2E_OUTPUT_DIR support — change by hand' };
      fs.writeFileSync(at('e2e/playwright.config.ts'), next);
      return 'patched';
    },
  },
  {
    id: 'gitignore-focus', set: 'speed', what: '.gitignore ignores the focus run output',
    pending: () => exists(at('.gitignore')) && !readText(at('.gitignore')).includes('e2e/report-focus/'),
    apply: () => { fs.appendFileSync(at('.gitignore'), `${readText(at('.gitignore')).endsWith('\n') ? '' : '\n'}e2e/report-focus/\ne2e/test-results-focus/\n`); return 'appended'; },
  },
];

if (!ctx.appDir || !ctx.app) { console.error('migrate: no active app'); process.exit(1); }
const sets = ['speed'].filter((x) => args[x]);
const items = ITEMS.filter((i) => !sets.length || sets.includes(i.set));
const rec = readJson(migrationsPath(ctx.app), { applied: {}, refused: {} });
const pending = items.filter((i) => !rec.refused?.[i.id] && i.pending());

if (args.check) {
  if (!pending.length) { console.log('migrate: nothing pending'); process.exit(0); }
  console.log(`MIGRATION PENDING (${pending.length}):\n${pending.map((i) => `  - ${i.id}: ${i.what}`).join('\n')}`);
  process.exit(10);
}
if ((ctx.state?.subStep || 'none') !== 'none') { console.error(`migrate: only between slices (subStep none) — now ${ctx.state.subStep}`); process.exit(1); }
if (!pending.length) { console.log('migrate: nothing pending'); process.exit(0); }
if (args['dry-run']) { console.log(`DRY RUN — would apply:\n${pending.map((i) => `  - ${i.id}: ${i.what}`).join('\n')}`); process.exit(0); }

const now = new Date().toISOString();
for (const i of pending) {
  const r = i.apply();
  if (typeof r === 'object' && r.refused) { rec.refused[i.id] = { at: now, reason: r.refused }; console.log(`REFUSED  ${i.id}: ${r.refused}`); }
  else { rec.applied[i.id] = now; console.log(`APPLIED  ${i.id}: ${i.what} (${r})`); }
}
writeJson(migrationsPath(ctx.app), rec);
console.log('Next: verify (must be GREEN), then commit.');
process.exit(0);
