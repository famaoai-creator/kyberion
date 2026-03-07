import { logger, safeWriteFile } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { chromium, Browser, Page } from 'playwright';

/**
 * Browser-Actuator v1.0.0
 * Unified interface for Web Automation and Recording.
 */

interface BrowserAction {
  action: 'navigate' | 'extract' | 'screenshot' | 'codegen' | 'execute_scenario';
  url?: string;
  scenario?: any[]; // Array of step definitions
  output_path?: string;
  options?: {
    headless?: boolean;
    timeout?: number;
  };
}

async function handleAction(input: BrowserAction) {
  const headless = input.options?.headless !== false;
  let browser: Browser | null = null;
  
  try {
    switch (input.action) {
      case 'navigate': {
        logger.info(`🌐 [BROWSER] Navigating to ${input.url}`);
        browser = await chromium.launch({ headless });
        const page = await browser.newPage();
        await page.goto(input.url || 'about:blank', { waitUntil: 'networkidle' });
        const title = await page.title();
        return { status: 'success', url: page.url(), title };
      }
      
      case 'extract': {
        logger.info(`🕸️ [BROWSER] Extracting content from ${input.url}`);
        browser = await chromium.launch({ headless });
        const page = await browser.newPage();
        await page.goto(input.url || 'about:blank', { waitUntil: 'networkidle' });
        const content = await page.content();
        if (input.output_path) {
           safeWriteFile(path.resolve(process.cwd(), input.output_path), content);
        }
        return { status: 'success', extracted_length: content.length };
      }
      
      case 'screenshot': {
        logger.info(`📸 [BROWSER] Taking screenshot of ${input.url}`);
        if (!input.output_path) throw new Error("output_path is required for screenshot");
        browser = await chromium.launch({ headless });
        const page = await browser.newPage();
        await page.goto(input.url || 'about:blank', { waitUntil: 'networkidle' });
        await page.screenshot({ path: path.resolve(process.cwd(), input.output_path), fullPage: true });
        return { status: 'success', path: input.output_path };
      }

      case 'execute_scenario': {
        logger.info(`🎬 [BROWSER] Executing scenario`);
        browser = await chromium.launch({ headless });
        const page = await browser.newPage();
        const steps = input.scenario || [];
        for (const step of steps) {
           if (step.action === 'goto') await page.goto(step.url, { waitUntil: 'networkidle' });
           if (step.action === 'click') await page.click(step.selector);
           if (step.action === 'fill') await page.fill(step.selector, step.text);
        }
        return { status: 'success', steps_executed: steps.length };
      }

      default:
        throw new Error(`Unsupported action: ${input.action}`);
    }
  } finally {
    if (browser) await browser.close();
  }
}

const main = async () => {
  const argv = await createStandardYargs()
    .option('input', { alias: 'i', type: 'string', required: true })
    .parseSync();

  const inputData = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), argv.input as string), 'utf8')) as BrowserAction;
  const result = await handleAction(inputData);
  console.log(JSON.stringify(result, null, 2));
};

if (require.main === module) {
  main().catch(err => {
    logger.error(err.message);
    process.exit(1);
  });
}
