import { safeWriteFile, safeReadFile } from '@agent/core';
import { chromium, Browser, BrowserContext, Page } from 'playwright';
import * as yaml from 'js-yaml';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

export interface ScenarioStep {
  action: string; url?: string; selector?: string; text?: string; value?: string; timeout?: number; credentials?: string;
  button?: string; confirm_buttons?: string[]; extract_keywords?: string[]; item_filter_keywords?: string[];
  item_filter_re?: string; exclude_keywords?: string[]; report_item_template?: string; save_path?: string;
}

export interface Scenario { name: string; steps: ScenarioStep[]; }

export function runBrowserScenario(specPath: string, rootDir: string): any {
  const cmd = `npx playwright test "${specPath}"`;
  const output = execSync(cmd, { cwd: rootDir, encoding: 'utf8' });
  try {
    return JSON.parse(output);
  } catch (_e) {
    return { raw: output };
  }
}

function resolvePlaceholders(text: string): string {
  const now = new Date();
  const replacements: { [key: string]: string } = {
    '{YYYY}': now.getFullYear().toString(), '{MM}': (now.getMonth() + 1).toString().padStart(2, '0'),
    '{DD}': now.getDate().toString().padStart(2, '0'), '{YY}': now.getFullYear().toString().slice(-2),
    '{M}': (now.getMonth() + 1).toString(), '{D}': now.getDate().toString(),
  };
  let resolved = text;
  for (const [key, val] of Object.entries(replacements)) { resolved = resolved.split(key).join(val); }
  return resolved;
}

export async function runYamlScenario(scenarioPath: string): Promise<any> {
  const content = safeReadFile(scenarioPath, { encoding: 'utf8' }) as string;
  const scenario = yaml.load(content) as Scenario;
  const browser: Browser = await chromium.launch({ headless: true, args: ['--ignore-certificate-errors', '--no-sandbox'] });
  const context: BrowserContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const page: Page = await context.newPage();
  const report: string[] = [`# Execution Report: ${scenario.name}\n`];

  try {
    for (const step of scenario.steps) {
      switch (step.action) {
        case 'goto':
          await page.goto(resolvePlaceholders(step.url!));
          await page.waitForLoadState('networkidle');
          break;
        case 'wait':
          await new Promise(r => setTimeout(r, step.timeout || 5000));
          break;
        case 'screenshot':
          await page.screenshot({ path: step.save_path || 'output.png' });
          break;
        case 'screenshot_svg':
          const viewport = page.viewportSize() || { width: 1280, height: 720 };
          const buffer = await page.screenshot({ type: 'png', fullPage: false });
          const base64 = buffer.toString('base64');
          const svg = `<svg width="${viewport.width}" height="${viewport.height}" viewBox="0 0 ${viewport.width} ${viewport.height}" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="data:image/png;base64,${base64}" width="${viewport.width}" height="${viewport.height}" /></svg>`;
          safeWriteFile(step.save_path || 'output.svg', svg);
          break;
        case 'visual_observe':
          const obs = await visualObserve(page, step.save_path);
          report.push(`  - Visual Observation: ${obs.summary}`);
          break;
        case 'click_robust':
          await robustClick(page, resolvePlaceholders(step.text || step.selector!));
          break;
        case 'loop_approve':
          await loopApprove(page, context, step, report);
          break;
      }
    }
    return { status: 'success', report: report.join('\n') };
  } catch (err: any) { return { status: 'error', error: err.message }; } finally { await browser.close(); }
}

async function visualObserve(page: Page, savePath?: string) {
  const finalPath = savePath || `observation-${Date.now()}.png`;
  await page.screenshot({ path: finalPath });
  const axTree = await (page as any).accessibility.snapshot();
  const buttonCount = JSON.stringify(axTree).match(/"role":"button"/g)?.length || 0;
  return { screenshot: finalPath, summary: `Captured ${buttonCount} buttons. State saved to ${finalPath}`, axTree };
}

async function robustClick(page: Page, target: string): Promise<boolean> {
  for (const frame of [page, ...page.frames()]) {
    try {
      const el = frame.locator(`text=${target}, button:has-text("${target}"), a:has-text("${target}")`).first();
      if (await el.isVisible()) { await el.scrollIntoViewIfNeeded(); await el.click({ force: true }); return true; }
    } catch { continue; }
  }
  return false;
}

async function loopApprove(page: Page, context: BrowserContext, step: ScenarioStep, report: string[]): Promise<number> {
  let count = 0;
  return count;
}
