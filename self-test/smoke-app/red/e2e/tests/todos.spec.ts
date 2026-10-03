import { expect, test } from '@playwright/test';

import { evidence } from './evidence';

// @trace FR-1
test('FR-1 add a todo and see it after reload', async ({ page }) => {
  const title = `Smoke todo ${Date.now()}`;
  await page.goto('/todos');
  await page.getByTestId('todo-title').fill(title);
  await page.getByTestId('todo-add').click();
  await expect(page.getByTestId('todo-row').filter({ hasText: title })).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('todo-row').filter({ hasText: title })).toBeVisible();
  await evidence(page, 'FR-1', 'todo-added');
});

// @trace FR-2
test('FR-2 blank title is rejected by the API', async ({ request }) => {
  const res = await request.post('/api/todos', { data: { title: '' } });
  expect(res.status()).toBe(400);
  expect((await res.json()).code).toBe('VALIDATION_FAILED');
});
