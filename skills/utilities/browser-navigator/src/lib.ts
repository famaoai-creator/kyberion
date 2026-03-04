import { safeWriteFile, safeReadFile } from '@agent/core';
import { chromium, Browser, BrowserContext, Page, Locator } from 'playwright';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Omni-Browser v2 (Sovereign Eye)
 * Alignment with 'browser-use' philosophy: index-based agentic interaction + human demonstration support.
 */

export interface ScenarioStep {
  action: 'goto' | 'click' | 'fill' | 'press' | 'wait' | 'snapshot' | 'screenshot' | 'extract' | 'observe';
  url?: string;
  index?: number;      // Index from UI Snapshot (Agentic)
  locator?: string;    // CSS/XPath/Playwright locator (Human Demo)
  text?: string;       // Text to fill or key to press
  ms?: number;         // Wait time
  save_path?: string;
  reasoning?: string;  // AI justification for the action
  schema?: any;        // Structure for data extraction
}

export interface Scenario {
  name: string;
  description?: string;
  steps: ScenarioStep[];
}

const ElementRegistry = new Map<number, Locator>();

/**
 * Main entry point for running v2 JSON scenarios.
 */
export async function runScenario(scenarioPath: string): Promise<any> {
  const content = fs.readFileSync(scenarioPath, 'utf8').trim();
  let scenario: Scenario;
  
  try {
    scenario = JSON.parse(content);
  } catch (err: any) {
    // Basic YAML to JSON shim for legacy support
    const yaml = require('js-yaml');
    scenario = yaml.load(content);
  }

  const browser = await chromium.launch({ headless: false, args: ['--ignore-certificate-errors'] });
  const context = await browser.newContext();
  const page = await context.newPage();
  const report: string[] = [`# Sovereign Eye Execution: ${scenario.name}\n`];

  console.log(`🚀 Executing Scenario: ${scenario.name}`);

  try {
    for (const step of scenario.steps) {
      if (step.reasoning) console.log(`💭 Reasoning: ${step.reasoning}`);
      
      let target: Locator | undefined;

      // Resolve Target (Hybrid approach)
      if (step.index !== undefined && ElementRegistry.has(step.index)) {
        target = ElementRegistry.get(step.index);
      } else if (step.locator) {
        // Support Playwright locator strings like 'role=button[name="..."]'
        target = page.locator(step.locator);
      }

      switch (step.action) {
        case 'goto':
          await page.goto(step.url!, { waitUntil: 'load' });
          report.push(`- Navigated to: ${step.url}`);
          break;

        case 'click':
          if (target) {
            const firstTarget = target.first();
            await firstTarget.scrollIntoViewIfNeeded();
            await firstTarget.click({ force: true });
            report.push(`- Clicked: ${step.index || step.locator}`);
          }
          break;

        case 'fill':
          if (target) {
            const firstTarget = target.first();
            await firstTarget.fill(step.text || '');
            report.push(`- Filled ${step.index || step.locator} with text.`);
          }
          break;

        case 'press':
          if (target) {
            await target.press(step.text || 'Enter');
          } else {
            await page.keyboard.press(step.text || 'Enter');
          }
          break;

        case 'wait':
          await page.waitForTimeout(step.ms || 3000);
          break;

        case 'snapshot':
          const snapshot = await buildAIAccessibleSnapshot(page);
          const sPath = step.save_path || 'snapshot.json';
          safeWriteFile(sPath, JSON.stringify(snapshot, null, 2));
          report.push(`- UI Snapshot captured (${snapshot.elements.length} elements).`);
          break;

        case 'screenshot':
          await page.screenshot({ path: step.save_path || 'output.png' });
          report.push(`- Screenshot saved to ${step.save_path}`);
          break;

        case 'extract':
          // Future: Add LLM-guided extraction logic here
          const data = await page.evaluate(() => document.body.innerText.substring(0, 5000));
          safeWriteFile(step.save_path || 'extracted.txt', data);
          report.push(`- Data extracted to ${step.save_path}`);
          break;
      }
      await page.waitForTimeout(500); // Breathe
    }
    return { status: 'success', report: report.join('\n') };
  } catch (err: any) {
    console.error(`❌ Execution Error: ${err.message}`);
    return { status: 'error', error: err.message };
  } finally {
    await browser.close();
  }
}

async function buildAIAccessibleSnapshot(page: Page) {
  ElementRegistry.clear();
  let refCounter = 1;
  const elements = [];

  const locators = await page.locator('button, a, input, textarea, select, [role="button"], [role="link"]').all();
  
  for (const loc of locators) {
    if (!(await loc.isVisible())) continue;

    const tagName = await loc.evaluate(el => el.tagName.toLowerCase());
    const text = (await loc.innerText() || await loc.getAttribute('aria-label') || '').trim();
    if (text === '' && tagName !== 'input') continue;

    const id = refCounter++;
    ElementRegistry.set(id, loc);
    elements.push({ index: id, type: tagName, text: text.substring(0, 100) });
  }

  return {
    url: page.url(),
    title: await page.title(),
    elements
  };
}
