import { safeWriteFile, safeReadFile } from '@agent/core';
import { chromium, Browser, BrowserContext, Page, Locator, Frame, Download } from 'playwright';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';

/**
 * Omni-Browser v2 (Surgical Refit Phase 3 - Bulletproof Edition)
 * Final features: Network Idle, Drag/Drop, Scroll, Ask Human, Headless Toggle.
 */

export interface ScenarioStep {
  action: 'goto' | 'click' | 'fill' | 'press' | 'wait' | 'snapshot' | 'screenshot' | 'extract' | 'observe' | 'login' | 'loop_action' | 'back' | 'select' | 'hover' | 'upload' | 'download' | 'switch_tab' | 'accept_dialog' | 'drag_and_drop' | 'scroll' | 'wait_until_idle' | 'ask_human';
  url?: string;
  index?: number;      // Index from UI Snapshot (Agentic)
  locator?: string;    // CSS/XPath/Playwright locator (Human Demo)
  target_locator?: string; // For 'drag_and_drop'
  text?: string;       // Text to fill, key to press, or option to select
  ms?: number;         // Wait time
  save_path?: string;
  reasoning?: string;  // AI justification for the action
  schema?: any;        // Structure for data extraction
  connection_id?: string; // For 'login' action
  user_locator?: string;  // Custom user field selector
  pass_locator?: string;  // Custom pass field selector
  submit_locator?: string; // Custom submit button selector
  list_locator?: string; // For 'loop_action'
  sub_scenario?: ScenarioStep[]; // For 'loop_action'
  go_back?: boolean;     // For 'loop_action' items
  tab_index?: number;    // For 'switch_tab'
  file_paths?: string[]; // For 'upload'
  direction?: 'up' | 'down' | 'left' | 'right'; // For 'scroll'
  distance?: number;      // For 'scroll'
  prompt?: string;        // For 'ask_human'
}

export interface Scenario {
  name: string;
  description?: string;
  headful?: boolean;     // Run with visible browser
  steps: ScenarioStep[];
}

const ElementRegistry = new Map<number, Locator>();

/**
 * Main entry point for running v2 JSON scenarios.
 */
export async function runScenario(scenarioPath: string, options: { headful?: boolean } = {}): Promise<any> {
  const content = fs.readFileSync(scenarioPath, 'utf8').trim();
  let scenario: Scenario;
  
  try {
    scenario = JSON.parse(content);
  } catch (err: any) {
    const yaml = require('js-yaml');
    scenario = yaml.load(content);
  }

  // Headful if specified in options OR in the scenario file
  const isHeadful = options.headful || scenario.headful || false;
  
  const browser = await chromium.launch({ 
    headless: !isHeadful, 
    args: ['--ignore-certificate-errors'] 
  });
  
  const context = await browser.newContext();
  context.on('page', page => setupPageHandlers(page));

  const currentPage = await context.newPage();
  setupPageHandlers(currentPage);

  const report: string[] = [`# Sovereign Eye Execution: ${scenario.name}\n`];
  console.log(`🚀 Executing Scenario: ${scenario.name} (Headless: ${!isHeadful})`);

  try {
    const session = { context, currentPage };
    await executeSteps(session, scenario.steps, report);
    return { status: 'success', report: report.join('\n') };
  } catch (err: any) {
    console.error(`❌ Execution Error: ${err.message}`);
    return { status: 'error', error: err.message };
  } finally {
    await browser.close();
  }
}

function setupPageHandlers(page: Page) {
  page.on('dialog', async dialog => {
    console.log(`💬 Dialog detected: [${dialog.type()}] ${dialog.message()}`);
    await dialog.accept().catch(() => {});
  });
  page.on('popup', popup => {
    console.log(`📑 Popup detected: ${popup.url()}`);
  });
}

interface BrowserSession {
  context: BrowserContext;
  currentPage: Page;
}

async function executeSteps(session: BrowserSession, steps: ScenarioStep[], report: string[]) {
  for (const step of steps) {
    const page = session.currentPage;
    if (step.reasoning) console.log(`💭 Reasoning: ${step.reasoning}`);
    
    let target: Locator | undefined;

    if (step.index !== undefined && ElementRegistry.has(step.index)) {
      target = ElementRegistry.get(step.index);
    } else if (step.locator) {
      target = await findTargetAcrossFrames(page, step.locator);
    }

    switch (step.action) {
      case 'goto':
        await page.goto(step.url!, { waitUntil: 'load' });
        report.push(`- Navigated to: ${step.url}`);
        break;

      case 'back':
        await page.goBack();
        report.push(`- Navigated back.`);
        break;

      case 'click':
        if (target) {
          await target.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
          await target.click({ force: true });
          report.push(`- Clicked: ${step.index || step.locator}`);
        }
        break;

      case 'fill':
        if (target) {
          await target.fill(step.text || '');
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

      case 'select':
        if (target) {
          await target.selectOption(step.text || '');
          report.push(`- Selected option in ${step.index || step.locator}.`);
        }
        break;

      case 'hover':
        if (target) {
          await target.hover();
          report.push(`- Hovered over ${step.index || step.locator}.`);
        }
        break;

      case 'drag_and_drop':
        if (target && step.target_locator) {
          const destination = await findTargetAcrossFrames(page, step.target_locator);
          await target.dragTo(destination);
          report.push(`- Dragged ${step.locator} to ${step.target_locator}.`);
        }
        break;

      case 'scroll':
        if (target) {
          await target.scrollIntoViewIfNeeded();
        } else {
          const d = step.direction === 'up' ? -1 : 1;
          const dist = step.distance || 500;
          await page.evaluate((y) => window.scrollBy(0, y), d * dist);
        }
        report.push(`- Scrolled ${step.direction || 'view'}.`);
        break;

      case 'wait_until_idle':
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
        report.push(`- Waited for network idle.`);
        break;

      case 'upload':
        if (target && step.file_paths) {
          await target.setInputFiles(step.file_paths.map(p => path.resolve(process.cwd(), p)));
          report.push(`- Uploaded files to ${step.index || step.locator}.`);
        }
        break;

      case 'download':
        if (target) {
          const downloadPromise = page.waitForEvent('download');
          await target.click();
          const download = await downloadPromise;
          const savePath = step.save_path || path.join(process.cwd(), download.suggestedFilename());
          await download.saveAs(savePath);
          report.push(`- Downloaded file saved to ${savePath}`);
        }
        break;

      case 'switch_tab':
        await page.waitForTimeout(1000);
        const pages = session.context.pages();
        const idx = step.tab_index || 0;
        if (pages[idx]) {
          session.currentPage = pages[idx];
          await session.currentPage.bringToFront();
          report.push(`- Switched to tab #${idx}`);
        }
        break;

      case 'ask_human':
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        console.log(`\n🛑 PAUSED: ${step.prompt || 'Please complete the manual step in the browser.'}`);
        await new Promise(res => rl.question('Press ENTER when you are ready to resume...', () => {
          rl.close();
          res(true);
        }));
        report.push(`- Paused for human intervention: ${step.prompt}`);
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

      case 'login':
        await handleLogin(page, step, report);
        break;

      case 'loop_action':
        await handleLoopAction(session, step, report);
        break;

      case 'extract':
        const frames = page.frames();
        let fullText = '';
        for (const frame of frames) {
          try {
            const frameText = await frame.evaluate(() => document.body.innerText).catch(() => '');
            fullText += `--- Frame: ${frame.url()} ---\n${frameText}\n\n`;
          } catch (_) {}
        }
        safeWriteFile(step.save_path || 'extracted.txt', fullText.substring(0, 10000));
        report.push(`- Data extracted to ${step.save_path}`);
        break;
    }
    await page.waitForTimeout(500); // Breathe
  }
}

async function findTargetAcrossFrames(page: Page, selector: string): Promise<Locator> {
  const mainLocator = page.locator(selector);
  if (await mainLocator.first().isVisible().catch(() => false)) return mainLocator;
  const frames = page.frames();
  for (const frame of frames) {
    const frameLocator = frame.locator(selector);
    if (await frameLocator.first().isVisible().catch(() => false)) return frameLocator;
  }
  return mainLocator;
}

async function handleLogin(page: Page, step: ScenarioStep, report: string[]) {
  const connectionId = step.connection_id!;
  console.log(`🔑 Resolving credentials for: ${connectionId}`);
  const possiblePaths = [
    path.join(process.cwd(), 'knowledge/personal/connections', `${connectionId}.json`),
    path.join(process.cwd(), 'knowledge/confidential/connections', `${connectionId}.json`),
    path.join(process.cwd(), 'knowledge/personal/connections', `${connectionId}`, `${path.basename(connectionId)}.json`),
    path.join(process.cwd(), 'knowledge/personal/connections', `${connectionId}`, `credentials.json`)
  ];
  let connPath = '';
  for (const p of possiblePaths) { if (fs.existsSync(p)) { connPath = p; break; } }
  if (!connPath) throw new Error(`Connection file not found for ${connectionId}`);
  const creds = JSON.parse(fs.readFileSync(connPath, 'utf8'));
  const user = creds.username || creds.user || creds.email || creds.login_id;
  const pass = creds.password || creds.pass || creds.secret;
  if (!user || !pass) throw new Error(`Incomplete credentials in ${connectionId}`);
  const userSelectors = step.user_locator ? [step.user_locator] : (creds.user_selector ? [creds.user_selector] : ['input[type="text"]', 'input[type="email"]', '#username', '#userid', '#login_id', 'input[name="user"]', 'input[name="username"]', '[autocomplete="username"]']);
  const passSelectors = step.pass_locator ? [step.pass_locator] : (creds.pass_selector ? [creds.pass_selector] : ['input[type="password"]', '#password', '#passwd', 'input[name="password"]', 'input[name="pass"]', '[autocomplete="current-password"]']);
  let userFound = false;
  for (const sel of userSelectors) {
    const loc = await findTargetAcrossFrames(page, sel);
    if (await loc.isVisible().catch(() => false)) { await loc.fill(user); userFound = true; break; }
  }
  if (!userFound) throw new Error(`Could not find username field for ${connectionId}`);
  let passFound = false;
  for (const sel of passSelectors) {
    const loc = await findTargetAcrossFrames(page, sel);
    if (await loc.isVisible().catch(() => false)) { await loc.fill(pass); passFound = true; break; }
  }
  if (!passFound) throw new Error(`Could not find password field for ${connectionId}`);
  if (step.submit_locator) { (await findTargetAcrossFrames(page, step.submit_locator)).click(); }
  else if (creds.submit_selector) { (await findTargetAcrossFrames(page, creds.submit_selector)).click(); }
  else { await page.keyboard.press('Enter'); }
  await page.waitForTimeout(2000);
  report.push(`- Logged in using connection: ${connectionId}`);
}

async function handleLoopAction(session: BrowserSession, step: ScenarioStep, report: string[]) {
  if (!step.list_locator || !step.sub_scenario) return;
  const page = session.currentPage;
  const listLocator = await findTargetAcrossFrames(page, step.list_locator);
  const count = await listLocator.count();
  console.log(`🔄 Looping over ${count} items found by ${step.list_locator}`);
  for (let i = 0; i < count; i++) {
    console.log(`  - Item ${i + 1}/${count}`);
    const currentItems = await findTargetAcrossFrames(page, step.list_locator);
    const item = currentItems.nth(i);
    await item.scrollIntoViewIfNeeded().catch(() => {});
    await item.click({ force: true });
    await page.waitForTimeout(2000);
    await executeSteps(session, step.sub_scenario, report);
    if (step.go_back) { await page.goBack(); await page.waitForTimeout(1000); await page.waitForSelector(step.list_locator, { state: 'visible', timeout: 5000 }).catch(() => {}); }
  }
}

async function buildAIAccessibleSnapshot(page: Page) {
  ElementRegistry.clear();
  let refCounter = 1;
  const elements: any[] = [];
  const frames = page.frames();
  for (const frame of frames) {
    try {
      const locators = await frame.locator('button, a, input, textarea, select, [role="button"], [role="link"]').all();
      for (const loc of locators) {
        if (!(await loc.isVisible().catch(() => false))) continue;
        const tagName = await loc.evaluate(el => el.tagName.toLowerCase()).catch(() => 'unknown');
        const text = (await loc.innerText().catch(() => '') || await loc.getAttribute('aria-label').catch(() => '') || '').trim();
        if (text === '' && tagName !== 'input') continue;
        const id = refCounter++;
        ElementRegistry.set(id, loc);
        elements.push({ index: id, type: tagName, text: text.substring(0, 100), frame: frame.name() || frame.url().substring(0, 50) });
      }
    } catch (_) {}
  }
  return { url: page.url(), title: await page.title(), elements };
}
