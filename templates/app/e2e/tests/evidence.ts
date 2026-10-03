import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';

/**
 * Saves QA evidence for a requirement as docs/<phase>/05_release/qa/screenshots/<FR-x>-<name>.png.
 * The directory comes from QA_SCREENSHOTS_DIR, set by factory-engine/bin/e2e.mjs.
 */
export async function evidence(page: Page, fr: string, name: string): Promise<void> {
  const dir = process.env.QA_SCREENSHOTS_DIR;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${fr}-${name}.png`), fullPage: true });
}
