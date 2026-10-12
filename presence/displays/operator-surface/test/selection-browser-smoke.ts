/**
 * Opt-in browser regression script. Start the isolated test/browser Next app first.
 * node --import ./scripts/ts-loader.mjs presence/displays/operator-surface/test/selection-browser-smoke.ts [chromium-executable]
 * Uses existing Playwright and an installed browser; never downloads or disables its sandbox.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';
import { withExecutionContextAsync } from '@agent/core/authority';
import { safeMkdir, safeWriteFile } from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';

async function waitReady(page: Page) {
  await page.getByRole('button', { name: 'Edit', exact: true }).waitFor({ state: 'visible' });
  await page.waitForFunction(() => {
    const edit = Array.from(document.querySelectorAll('button')).find(
      (node) => node.textContent === 'Edit'
    );
    const hasRead = /Reads: [1-9][0-9]*/.test(document.querySelector('output')?.textContent ?? '');
    return (
      hasRead &&
      edit &&
      !edit.disabled &&
      !Array.from(document.querySelectorAll('[role="status"]')).some((node) =>
        node.textContent?.includes('Working')
      )
    );
  });
}
async function counters(page: Page) {
  const text = await page.getByLabel('Fixture request counters').innerText();
  return {
    writes: Number(text.match(/Writes: (\d+)/)?.[1]),
    saves: Number(text.match(/Save requests: (\d+)/)?.[1]),
    previews: Number(text.match(/Previews: (\d+)/)?.[1]),
  };
}
async function assertEditorErrorAssociation(page: Page, expected: RegExp) {
  const association = await page.locator('form fieldset').evaluate((group) => {
    const errors = (group.getAttribute('aria-errormessage') || '').split(/\s+/).filter(Boolean);
    const descriptions = (group.getAttribute('aria-describedby') || '').split(/\s+/);
    return {
      invalid: group.getAttribute('aria-invalid'),
      errors,
      linked: errors.every((id) => descriptions.includes(id) && document.getElementById(id)),
      text: errors.map((id) => document.getElementById(id)?.textContent || '').join(' '),
    };
  });
  assert.equal(association.invalid, 'true');
  assert.ok(association.errors.length, 'editor must identify its error message');
  assert.equal(
    association.linked,
    true,
    'error ID references must resolve and describe the editor'
  );
  assert.match(association.text, expected);
}
export async function runSelectionBrowserSmoke(
  options: { baseUrl?: string; executablePath?: string; signal?: AbortSignal } = {}
) {
  const baseUrl = options.baseUrl ?? 'http://127.0.0.1:3342';
  assert.match(baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/, 'synthetic fixture must be loopback-only');
  const browser = await chromium.launch({
    headless: true,
    chromiumSandbox: true,
    timeout: 20_000,
    ...(options.executablePath ? { executablePath: options.executablePath } : {}),
  });
  const abort = () => {
    void browser.close();
  };
  options.signal?.addEventListener('abort', abort, { once: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.setDefaultNavigationTimeout(20_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const output = pathResolver.rootResolve(
    'active/shared/tmp/operator-selection-browser-' + crypto.randomUUID()
  );
  safeMkdir(output, { recursive: true });
  try {
    await page.goto(baseUrl);
    assert.equal(
      await page.getByRole('heading', { name: 'Synthetic selection settings fixture' }).count(),
      1
    );
    await waitReady(page);
    const initial = await counters(page);
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.getByLabel('Selection mode', { exact: true }).selectOption('fixed');
    await page.getByLabel('Agent identity', { exact: true }).selectOption('agent-lyra');
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    await page.getByRole('heading', { name: 'Preview result' }).waitFor();
    assert.equal((await counters(page)).writes, initial.writes, 'preview must not write');
    safeWriteFile(
      output + '/desktop-light-en-preview.png',
      await page.screenshot({ fullPage: true })
    );
    // Same-tick duplicate clicks exercise the synchronous request gate, not only disabled styling.
    await page
      .getByRole('button', { name: 'Save', exact: true })
      .evaluate((button: HTMLButtonElement) => {
        button.click();
        button.click();
      });
    await waitReady(page);
    const saved = await counters(page);
    assert.equal(saved.writes, initial.writes + 1);
    assert.equal(saved.saves, initial.saves + 1);
    assert.match(await page.getByLabel('Current settings').innerText(), /agent-lyra/);

    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.waitForTimeout(850);
    assert.equal(await page.getByRole('heading', { name: 'Preview result' }).count(), 0);
    assert.equal(
      (await counters(page)).writes,
      saved.writes,
      'cancel during preview must not write'
    );

    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    await page.getByRole('heading', { name: 'Preview result' }).waitFor();
    await page.getByRole('button', { name: 'Simulate concurrent change' }).click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByText('Settings changed elsewhere. Reload before editing again.').waitFor();
    await assertEditorErrorAssociation(page, /Settings changed elsewhere/);
    const statusId = await page.locator('[role="status"][aria-atomic="true"]').getAttribute('id');
    assert.equal(
      await page.getByRole('button', { name: 'Reload settings' }).getAttribute('aria-describedby'),
      statusId
    );
    assert.equal((await counters(page)).writes, saved.writes, 'stale save must be rejected');
    await page.getByRole('button', { name: 'Reload settings' }).click();
    await waitReady(page);

    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.getByLabel('Selection mode', { exact: true }).selectOption('fixed');
    await page.getByLabel('Agent identity', { exact: true }).selectOption('agent-offline');
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    await page.getByRole('heading', { name: 'Preview result' }).waitFor();
    await assertEditorErrorAssociation(page, /Synthetic fixed target unavailable/);
    assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).isDisabled(), true);
    await page.getByLabel('Agent identity', { exact: true }).selectOption('agent-lyra');
    assert.equal(
      await page.locator('form fieldset').getAttribute('aria-errormessage'),
      null,
      'editing clears stale error associations'
    );
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal((await counters(page)).writes, saved.writes, 'invalid preview must not write');

    await page.getByRole('button', { name: 'Reasoning fixture', exact: true }).click();
    await page.getByRole('heading', { name: 'Reasoning runtime selection' }).waitFor();
    await waitReady(page);
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.getByLabel('Selection mode', { exact: true }).selectOption('preferred');
    await page.getByLabel('Runtime', { exact: true }).selectOption('fixture-offline');
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    await page.getByRole('heading', { name: 'Preview result' }).waitFor();
    assert.match(await page.getByLabel('Preview result').innerText(), /automatic fallback/);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.goBack();
    await page.getByRole('heading', { name: 'Mission agent selection' }).waitFor();
    await waitReady(page);
    assert.equal(await page.getByRole('heading', { name: 'Mission agent selection' }).count(), 1);
    await page.goForward();
    await page.getByRole('heading', { name: 'Reasoning runtime selection' }).waitFor();
    await waitReady(page);
    assert.equal(
      await page.getByRole('heading', { name: 'Reasoning runtime selection' }).count(),
      1
    );

    await page.getByRole('button', { name: 'Read-only fixture', exact: true }).click();
    await page
      .getByText('Read-only. An authenticated administrator with the required scope can edit.')
      .waitFor();
    assert.equal(await page.getByRole('button', { name: 'Edit', exact: true }).count(), 0);
    await page.getByRole('button', { name: 'Mission fixture', exact: true }).click();
    await waitReady(page);
    safeWriteFile(output + '/desktop-light-en.png', await page.screenshot({ fullPage: true }));
    await page.getByRole('button', { name: 'Toggle theme' }).click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    safeWriteFile(output + '/desktop-dark-en.png', await page.screenshot({ fullPage: true }));
    await page.getByRole('button', { name: 'Toggle language' }).click();
    await page.getByRole('button', { name: '編集', exact: true }).waitFor();
    await page.getByRole('button', { name: '編集', exact: true }).click();
    await page.getByLabel('選択方式', { exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    safeWriteFile(output + '/mobile-dark-ja.png', await page.screenshot({ fullPage: true }));
    await page.getByRole('button', { name: 'Toggle theme' }).click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    safeWriteFile(output + '/mobile-light-ja.png', await page.screenshot({ fullPage: true }));
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      true,
      'mobile layout must not overflow horizontally'
    );
    assert.deepEqual(errors, [], 'browser page errors');
    return {
      ok: true,
      previewWrites: 0,
      repeatedSaveWrites: 1,
      pendingCancel: true,
      staleRejected: true,
      backForward: true,
      readonly: true,
      languages: ['en', 'ja'],
      themes: ['light', 'dark'],
      screenshotDirectory: output,
    };
  } finally {
    options.signal?.removeEventListener('abort', abort);
    await context.close();
    await browser.close();
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await withExecutionContextAsync('ecosystem_architect', () =>
    runSelectionBrowserSmoke({ executablePath: process.argv[2] })
  );
  process.stdout.write(JSON.stringify(report) + '\n');
}
