import { logger, safeReadFile, safeWriteFile } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as path from 'node:path';
import * as fs from 'node:fs';

/**
 * Browser-Actuator v1.1.0 [SECURE-IO ENFORCED]
 * Strictly compliant with Layer 2 (Shield).
 */

import { chromium, Browser } from 'playwright';

/**
 * Browser-Actuator v1.2.0 [PLAYWRIGHT ENABLED]
 * Strictly compliant with Layer 2 (Shield).
 */

interface BrowserAction {
  action: 'navigate' | 'extract' | 'screenshot' | 'execute_scenario' | 'launch' | 'close';
  url?: string;
  scenario?: any[];
  output_path?: string;
  session_id?: string;
  options?: any;
}

const BROWSER_RUNTIME_DIR = path.join(process.cwd(), 'active/shared/runtime/browser');

async function handleAction(input: BrowserAction) {
  const sessionId = input.session_id || 'default';
  const userDataDir = path.join(BROWSER_RUNTIME_DIR, sessionId);
  
  if (!fs.existsSync(userDataDir)) {
    fs.mkdirSync(userDataDir, { recursive: true });
  }

  let browserContext: any = null;
  
  try {
    if (input.action === 'launch') {
      logger.info(`🚀 [BROWSER] Launching persistent session: ${sessionId}`);
      const browser = await chromium.launchPersistentContext(userDataDir, {
        headless: input.options?.headless !== false,
        viewport: { width: 1280, height: 720 }
      });
      // In persistent mode, we don't close the browser in finally unless requested
      return { status: 'launched', sessionId, userDataDir };
    }

    if (input.action === 'extract' && input.url) {
      const browser = await chromium.launchPersistentContext(userDataDir, { headless: true });
      const page = await browser.newPage();
      await page.goto(input.url, { waitUntil: 'networkidle' });
      const content = await page.innerText('body');
      await browser.close();
      return { status: 'success', content };
    }

    if (input.action === 'screenshot' || input.action === 'snapshot') {
      const outputPath = input.output_path || `evidence/screenshots/browser_${Date.now()}.png`;
      const fullPath = path.resolve(process.cwd(), outputPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });

      const browser = await chromium.launchPersistentContext(userDataDir, { headless: true });
      const page = browser.pages().length > 0 ? browser.pages()[0] : await browser.newPage();
      
      // If snaphot, don't navigate, just capture current state
      if (input.action === 'screenshot' && input.url) {
        await page.goto(input.url, { waitUntil: 'networkidle' });
      }
      
      await page.screenshot({ path: fullPath });
      const title = await page.title();
      const url = page.url();
      await browser.close();
      
      return { status: 'captured', path: outputPath, url, title };
    }

    if (input.action === 'execute_scenario' && input.scenario) {
      const browser = await chromium.launchPersistentContext(userDataDir, { 
        headless: input.options?.headless !== false 
      });
      
      // Use existing page if available, otherwise create one
      const page = browser.pages().length > 0 ? browser.pages()[0] : await browser.newPage();
      
      let extractionResult: any = null;

      // Initial navigation if URL is provided at top level
      if (input.url) {
        logger.info(`🌐 [BROWSER] Navigating to: ${input.url}`);
        await page.goto(input.url, { waitUntil: 'domcontentloaded' });
      }

      for (const step of input.scenario) {
        logger.info(`🌐 [BROWSER] Executing step: ${step.action}`);
        try {
          if (step.action === 'goto') {
            await page.goto(step.url, { waitUntil: 'networkidle' });
          } else if (step.action === 'click') {
            await page.click(step.selector, { timeout: 5000 });
          } else if (step.action === 'fill') {
            await page.fill(step.selector, step.text, { timeout: 5000 });
          } else if (step.action === 'press') {
            await page.press(step.selector, step.key, { timeout: 5000 });
          } else if (step.action === 'wait_for_selector') {
            await page.waitForSelector(step.selector, { timeout: 10000 });
          } else if (step.action === 'evaluate') {
            extractionResult = await page.evaluate(step.script);
          }
        } catch (stepError: any) {
          logger.warn(`⚠️ [BROWSER] Step ${step.action} failed: ${stepError.message}`);
        }
      }
      
      await browser.close();
      return { status: 'success', result: extractionResult };
    }
    
    return { status: 'executed', action: input.action };
  } catch (e: any) {
    logger.error(`Browser action failed: ${e.message}`);
    return { status: 'error', error: e.message };
  }
}

const main = async () => {
  const argv = await createStandardYargs().option('input', { alias: 'i', type: 'string', required: true }).parseSync();
  const inputContent = safeReadFile(path.resolve(process.cwd(), argv.input as string), { encoding: 'utf8' }) as string;
  const result = await handleAction(JSON.parse(inputContent));
  console.log(JSON.stringify(result, null, 2));
};

if (require.main === module) {
  main().catch(err => {
    logger.error(err.message);
    process.exit(1);
  });
}
