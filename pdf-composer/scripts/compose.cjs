#!/usr/bin/env node
/**
 * pdf-composer/scripts/compose.cjs
 * Modernized PDF Composer using themes and @agent/core.
 */

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const { marked } = require('marked');
const { runSkillAsync } = require('@agent/core');
const { requireArgs, validateFilePath } = require('@agent/core/validators');

runSkillAsync('pdf-composer', async () => {
  const args = requireArgs(['input', 'out']);
  validateFilePath(args.input, 'input markdown');

  const md = fs.readFileSync(args.input, 'utf8');
  const htmlBody = marked.parse(md);

  // Load External Theme
  const themePath = path.resolve(__dirname, '../../knowledge/templates/themes/standard.css');
  const cssStyle = fs.existsSync(themePath) ? fs.readFileSync(themePath, 'utf8') : '';

  const htmlContent = `
<!DOCTYPE html>
<html>
<head>
    <style>${cssStyle}</style>
</head>
<body>
    ${htmlBody}
</body>
</html>`;

  console.log('[PDF] Launching browser...');
  const browser = await puppeteer.launch({ headless: 'new' });
  const page = await browser.newPage();
  await page.setContent(htmlContent, { waitUntil: 'networkidle0' });

  await page.pdf({
    path: args.out,
    format: 'A4',
    margin: { top: '20mm', bottom: '20mm', left: '20mm', right: '20mm' },
    printBackground: true,
  });

  await browser.close();
  console.log(`[PDF] Success: ${args.out}`);

  return {
    status: 'success',
    input: args.input,
    output: args.out,
    theme: 'standard',
  };
});
