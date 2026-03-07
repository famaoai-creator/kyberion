import { logger, safeReadFile, safeWriteFile } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as path from 'node:path';

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
  action: 'navigate' | 'extract' | 'screenshot' | 'execute_scenario';
  url?: string;
  scenario?: any[];
  output_path?: string;
  options?: any;
}

async function handleAction(input: BrowserAction) {
  let browser: Browser | null = null;
  try {
    if (input.action === 'extract' && input.url) {
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      await page.goto(input.url, { waitUntil: 'networkidle' });
      const content = await page.innerText('body');
      return { status: 'success', content };
    }

    if (input.action === 'execute_scenario' && input.scenario) {
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      
      let extractionResult: any = null;

      for (const step of input.scenario) {
        logger.info(`🌐 [BROWSER] Executing step: ${step.action}`);
        if (step.action === 'goto') {
          await page.goto(step.url, { waitUntil: 'networkidle' });
        } else if (step.action === 'fill') {
          await page.fill(step.selector, step.text);
        } else if (step.action === 'press') {
          await page.press(step.selector, step.key);
        } else if (step.action === 'wait_for_selector') {
          await page.waitForSelector(step.selector, { timeout: 10000 });
        } else if (step.action === 'evaluate') {
          extractionResult = await page.evaluate(step.script);
        }
      }
      
      return { status: 'success', result: extractionResult };
    }
    
    return { status: 'executed', action: input.action };
  } catch (e: any) {
    logger.error(`Browser action failed: ${e.message}`);
    return { status: 'error', error: e.message };
  } finally {
    if (browser) await browser.close();
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
