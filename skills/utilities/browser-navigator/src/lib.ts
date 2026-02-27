import { chromium, Browser, BrowserContext, Page } from 'playwright';
import * as yaml from 'js-yaml';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ScenarioStep {
  action: string;
  url?: string;
  selector?: string;
  text?: string;
  value?: string;
  timeout?: number;
  credentials?: string;
  button?: string;
  confirm_buttons?: string[];
  extract_keywords?: string[];
  item_filter_keywords?: string[];
  item_filter_re?: string; // 正規表現でのフィルタ
  exclude_keywords?: string[]; // 除外ワード
  report_item_template?: string;
  save_path?: string;
}

export interface Scenario {
  name: string;
  steps: ScenarioStep[];
}

// 日付プレースホルダーの置換
function resolvePlaceholders(text: string): string {
  const now = new Date();
  const replacements: { [key: string]: string } = {
    '{YYYY}': now.getFullYear().toString(),
    '{MM}': (now.getMonth() + 1).toString().padStart(2, '0'),
    '{DD}': now.getDate().toString().padStart(2, '0'),
    '{YY}': now.getFullYear().toString().slice(-2),
    '{M}': (now.getMonth() + 1).toString(),
    '{D}': now.getDate().toString(),
  };

  let resolved = text;
  for (const [key, val] of Object.entries(replacements)) {
    resolved = resolved.split(key).join(val);
  }
  return resolved;
}

export async function runYamlScenario(scenarioPath: string): Promise<any> {
  const content = fs.readFileSync(scenarioPath, 'utf8');
  const scenario = yaml.load(content) as Scenario;

  const browser: Browser = await chromium.launch({
    headless: true,
    args: ['--ignore-certificate-errors'],
  });
  const context: BrowserContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const page: Page = await context.newPage();

  const report: string[] = [`# Execution Report: ${scenario.name}\n`];

  try {
    for (const step of scenario.steps) {
      console.error(`Executing step: ${step.action}...`);

      switch (step.action) {
        case 'goto':
          await page.goto(resolvePlaceholders(step.url!));
          await page.waitForLoadState('networkidle');
          break;

        case 'login':
          const creds = await loadCredentials(step.credentials!);
          await page.fill(
            'input[name*="user"], input[name*="account"], input[name*="uid"]',
            creds.user_id || creds.SEIKYU_USER_ID || ''
          );
          await page.fill(
            'input[name*="pass"], input[name*="pwd"]',
            creds.password || creds.SEIKYU_PASSWORD || ''
          );
          await page.click('input[type="submit"], button:has-text("ログイン"), .login-btn');
          await asyncioSleep(step.timeout || 10000);
          break;

        case 'click_robust':
          await robustClick(page, resolvePlaceholders(step.text || step.selector!));
          await asyncioSleep(step.timeout || 5000);
          break;

        case 'loop_approve':
          await loopApprove(page, context, step, report);
          break;

        case 'wait':
          await asyncioSleep(step.timeout || 5000);
          break;
      }
    }

    return { status: 'success', report: report.join('\n') };
  } catch (err: any) {
    return { status: 'error', error: err.message };
  } finally {
    await browser.close();
  }
}

async function asyncioSleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadCredentials(system: string): Promise<any> {
  const credPath = path.resolve(process.cwd(), `knowledge/personal/connections/${system}.json`);
  return JSON.parse(fs.readFileSync(credPath, 'utf8'));
}

async function robustClick(page: Page, target: string): Promise<boolean> {
  for (const frame of [page, ...page.frames()]) {
    try {
      const el = frame
        .locator(
          `text=${target}, input[value*="${target}"], button:has-text("${target}"), a:has-text("${target}")`
        )
        .first();
      if (await el.isVisible()) {
        await el.scrollIntoViewIfNeeded();
        await el.click({ force: true });
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

async function loopApprove(
  page: Page,
  context: BrowserContext,
  step: ScenarioStep,
  report: string[]
): Promise<number> {
  let count = 0;
  const processedTitles = new Set<string>();
  const listSelector = step.selector || 'a';
  const filterKeywords = (step.item_filter_keywords || []).map((k) => resolvePlaceholders(k));
  const filterRe = step.item_filter_re ? new RegExp(step.item_filter_re) : null;
  const excludeKeywords = step.exclude_keywords || [];
  const extractKeywords = step.extract_keywords || [];
  const reportTemplate = step.report_item_template || '### Item: {title}';

  while (count < 20) {
    let targetLink = null;
    let title = '';

    for (const frame of [page, ...page.frames()]) {
      const links = await frame.locator(listSelector).all();
      for (const link of links) {
        try {
          if (await link.isVisible()) {
            const txt = (await link.innerText()).trim();
            if (!txt || processedTitles.has(txt)) continue;

            // 除外キーワード判定
            if (excludeKeywords.some((ek) => txt.includes(ek))) continue;

            // フィルタ判定
            const matchesKeyword =
              filterKeywords.length === 0 || filterKeywords.some((k) => txt.includes(k));
            const matchesRe = !filterRe || filterRe.test(txt);

            if (matchesKeyword && matchesRe) {
              targetLink = link;
              title = txt;
              break;
            }
          }
        } catch {
          continue;
        }
      }
      if (targetLink) break;
    }

    if (!targetLink) break;
    processedTitles.add(title);
    report.push(reportTemplate.replace('{title}', title));

    await targetLink.click({ force: true });
    await asyncioSleep(8000);

    const bodyText = await page.innerText('body');
    const info = bodyText
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && extractKeywords.some((k) => l.includes(k)))
      .slice(0, 5)
      .join(' / ');

    if (info) report.push(`  - 抽出情報: ${info}`);

    if (await robustClick(page, step.button || '承認')) {
      report.push(`  => アクション「${step.button || '承認'}」完了`);
      await asyncioSleep(5000);
      for (const conf of step.confirm_buttons || ['OK', 'はい']) {
        await robustClick(page, conf);
      }
    }

    await page.goto(page.url());
    await asyncioSleep(10000);
    count++;
  }
  return count;
}
