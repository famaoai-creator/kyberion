const { test, expect: _expect } = require('@playwright/test');

test.setTimeout(120000);

test('JSM President Approval on Seikyu QUICK', async ({ page, context: _context }) => {
  const USER_ID = process.env.SEIKYU_USER_ID;
  const PASSWORD = process.env.SEIKYU_PASSWORD;
  const TARGET_COMPANY = 'SBI JIG-SAW';

  if (!USER_ID || !PASSWORD) {
    throw new Error('SEIKYU_USER_ID or SEIKYU_PASSWORD environment variables are not set.');
  }

  console.log('--- Start: Seikyu QUICK Approval Simulation (using secure env vars) ---');

  // 1. Login
  await page.goto('https://cbo.seikyuquick.jp/invoice');
  await page.waitForLoadState('networkidle');

  await page.locator('input[id="userid"]').fill(USER_ID);
  await page.locator('input[id="password"]').fill(PASSWORD);
  await page.locator('button:has-text("ログイン")').filter({ visible: true }).first().click();

  await page.waitForLoadState('networkidle');

  // 2. Company Selection
  if (await page.locator('text=ログインする会社を選択してください').isVisible({ timeout: 10000 })) {
    console.log('Selecting company...');
    await page.click(`text=${TARGET_COMPANY}`);
    await page.waitForLoadState('networkidle');
  }

  // 3. Navigate to Invoice Menu
  console.log('Navigating to Invoice menu...');
  await page.click('div.menu-title:has-text("請求")');
  await page.waitForLoadState('networkidle');

  // 4. Learning Phase
  console.log('--- Learning Phase ---');
  await page.click('text=発行済み');
  await page.waitForLoadState('networkidle');

  // 5. Approval Phase
  console.log('--- Approval Phase ---');
  await page.click('text=承認待ち');
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: 'work/screenshots/approval_list_secure.png' });

  console.log('--- Simulation Completed ---');
});