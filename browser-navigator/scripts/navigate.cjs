#!/usr/bin/env node
const { safeWriteFile } = require('../../scripts/lib/secure-io.cjs');
const fs = require('fs');
const path = require('path');
const pathResolver = require('../../scripts/lib/path-resolver.cjs');
const { execSync } = require('child_process');
const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');

const argv = createStandardYargs()
  .option('url', { alias: 'u', type: 'string', description: 'URL to navigate to' })
  .option('scenario', { alias: 's', type: 'string', description: 'Path to Playwright spec file' })
  .option('screenshot', { type: 'boolean', default: false, description: 'Take a screenshot' })
  .option('extract', { type: 'string', description: 'CSS selector to extract text from' })
  .option('out', { alias: 'o', type: 'string', description: 'Output file path' })
  .check((parsed) => {
    if (!parsed.url && !parsed.scenario) throw new Error('Either --url or --scenario is required');
    return true;
  }).argv;

const rootDir = path.resolve(__dirname, '../..');
const _scenariosDir = path.join(rootDir, 'knowledge/browser-scenarios');
const screenshotDir = path.join(rootDir, pathResolver.shared('screenshots'));

runSkill('browser-navigator', () => {
  // Scenario execution mode
  if (argv.scenario) {
    const specPath = path.resolve(argv.scenario);
    if (!fs.existsSync(specPath)) {
      throw new Error(`Scenario file not found: ${specPath}`);
    }

    try {
      const output = execSync(`npx playwright test "${specPath}" --reporter=json`, {
        encoding: 'utf8',
        cwd: rootDir,
        timeout: 60000,
        stdio: 'pipe',
      });
      return { mode: 'scenario', spec: specPath, result: 'passed', output };
    } catch (err) {
      return {
        mode: 'scenario',
        spec: specPath,
        result: 'failed',
        stdout: err.stdout || '',
        stderr: err.stderr || '',
      };
    }
  }

  // URL navigation mode - generate a quick Playwright script
  const url = argv.url;
  const actions = [];

  if (argv.screenshot) {
    if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });
    actions.push('screenshot');
  }
  if (argv.extract) {
    actions.push(`extract:${argv.extract}`);
  }

  const scriptContent = `
const { test, expect } = require('@playwright/test');
test('navigate', async ({ page }) => {
    await page.goto('${url.replace(/'/g, "\\'")}');
    ${
      argv.screenshot
        ? `
    await page.screenshot({ path: '${path.join(screenshotDir, 'latest.png').replace(/\\/g, '/')}', fullPage: true });
    `
        : ''
    }
    ${
      argv.extract
        ? `
    const elements = await page.locator('${argv.extract.replace(/'/g, "\\'")}').allTextContents();
    console.log(JSON.stringify({ extracted: elements }));
    `
        : ''
    }
});
`;

  const tmpSpec = path.join(rootDir, 'work', '_tmp_navigate.spec.cjs');
  safeWriteFile(tmpSpec, scriptContent);

  try {
    const _output = execSync(`npx playwright test "${tmpSpec}" --reporter=line`, {
      encoding: 'utf8',
      cwd: rootDir,
      timeout: 30000,
      stdio: 'pipe',
    });

    return {
      mode: 'navigate',
      url,
      actions,
      result: 'completed',
      screenshot: argv.screenshot ? path.join(screenshotDir, 'latest.png') : null,
    };
  } catch (err) {
    return {
      mode: 'navigate',
      url,
      result: 'failed',
      error: err.stderr || err.message,
    };
  } finally {
    if (fs.existsSync(tmpSpec)) require('../../scripts/lib/secure-io.cjs').safeUnlinkSync(tmpSpec);
  }
});
