// @ts-check
const { test, expect } = require('@playwright/test');

test('basic check', async ({ page }) => {
  await page.goto('https://example.com');

  // Expect a title "to contain" a substring.
  await expect(page).toHaveTitle(/Example Domain/);

  // Take a screenshot
  await page.screenshot({ path: 'work/screenshots/example-check.png', fullPage: true });
});
