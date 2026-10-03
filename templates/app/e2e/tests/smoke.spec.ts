import { expect, test } from '@playwright/test';

test('app shell loads and reaches the backend', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('app-title')).toBeVisible();
  await expect(page.getByTestId('backend-status')).toContainText('pong');
});
