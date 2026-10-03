import { defineConfig, devices } from '@playwright/test';

// Runs against the Docker stack (docker compose up). Reports feed gen-traceability and check-artifacts.
export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  retries: 0,
  reporter: [
    ['list'],
    ['json', { outputFile: 'report/results.json' }],
    ['junit', { outputFile: 'report/junit.xml' }],
  ],
  use: {
    baseURL: process.env.BASE_URL ?? 'http://localhost:4200',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
