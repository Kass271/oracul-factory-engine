import { defineConfig, devices } from '@playwright/test';

// Runs against the Docker stack (docker compose up). Reports feed gen-traceability and check-artifacts.
// Official runs use report/ and test-results/; tester scratch runs (stack.mjs e2e --scratch) set E2E_REPORT_DIR and
// E2E_OUTPUT_DIR so they never overwrite the official report or traces.
const reportDir = process.env.E2E_REPORT_DIR ?? 'report';

export default defineConfig({
  testDir: './tests',
  outputDir: process.env.E2E_OUTPUT_DIR ?? 'test-results',
  timeout: 30_000,
  retries: 0,
  reporter: [
    ['list'],
    ['json', { outputFile: `${reportDir}/results.json` }],
    ['junit', { outputFile: `${reportDir}/junit.xml` }],
  ],
  use: {
    baseURL: process.env.BASE_URL ?? 'http://localhost:4200',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
