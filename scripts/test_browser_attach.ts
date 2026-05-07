/**
 * Manual exploratory script — NOT part of the automated test suite.
 *
 * Spawns a headless Chrome with --remote-debugging-port=9222, then connects
 * over CDP from Playwright to verify the attach-to-browser-sample.json
 * pipeline path works end-to-end. Useful when iterating on the
 * device-restricted SSO flow (where the user authenticates by hand and
 * Kyberion attaches afterwards).
 *
 * Limitations (known, intentional for now):
 * - Hardcoded macOS Chrome path. Linux / Windows would need a different
 *   binary lookup; not generalized because this is exploratory.
 * - Uses raw `child_process.exec` rather than `safeExec` because the
 *   Chrome process is intentionally long-running and not subject to
 *   path-scope policy.
 * - Sleeps 3s for Chrome to start. Replace with a CDP-readiness probe
 *   before promoting to a real test.
 *
 * Usage: `pnpm tsx scripts/test_browser_attach.ts`
 */

import { chromium } from '@playwright/test';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

// promisify-wrapped exec is reserved for future use (e.g. detecting an
// existing Chrome binary). Keep the import surface stable while the script
// is iterated on.
const _execAsync = promisify(exec);
void _execAsync;

async function run() {
  console.log('Starting headless chrome with remote debugging port 9222...');
  // Note: Using a temp user data dir to avoid conflict with existing Chrome
  const chromeProcess = exec('"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --remote-debugging-port=9222 --user-data-dir=/tmp/kyberion-chrome-test');

  // Wait a bit for it to start
  await new Promise(resolve => setTimeout(resolve, 3000));

  try {
    console.log('Attempting to connect via CDP to http://127.0.0.1:9222...');
    const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
    console.log('Connected!');

    const contexts = browser.contexts();
    console.log(`Found ${contexts.length} contexts.`);

    const pages = contexts[0].pages();
    console.log(`Found ${pages.length} pages.`);

    for (const page of pages) {
      console.log(`- ${await page.title()} (${page.url()})`);
    }

    if (pages.length === 0) {
      console.log('Opening a new page to test...');
      const newPage = await contexts[0].newPage();
      await newPage.goto('https://www.google.com');
      console.log(`Opened: ${await newPage.title()}`);
    }

    await browser.close();
    console.log('Test completed successfully.');
  } catch (error) {
    console.error('Failed to connect:', error);
  } finally {
    chromeProcess.kill();
  }
}

run();
