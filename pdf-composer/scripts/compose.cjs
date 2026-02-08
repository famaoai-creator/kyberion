#!/usr/bin/env node
const fs = require('fs');
const puppeteer = require('puppeteer');
const { marked } = require('marked');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const { runAsyncSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { validateFilePath } = require('../../scripts/lib/validators.cjs');

const argv = yargs(hideBin(process.argv))
    .option('input', { alias: 'i', type: 'string', demandOption: true })
    .option('out', { alias: 'o', type: 'string', demandOption: true })
    .argv;

const CSS_STYLE = `
<style>
    body { font-family: 'Helvetica', 'Arial', sans-serif; padding: 40px; line-height: 1.6; }
    h1, h2, h3 { color: #333; }
    code { background: #f4f4f4; padding: 2px 5px; border-radius: 3px; font-family: 'Courier New', monospace; }
    pre { background: #f4f4f4; padding: 15px; border-radius: 5px; overflow-x: auto; }
    blockquote { border-left: 4px solid #ddd; padding-left: 15px; color: #666; }
    table { width: 100%; border-collapse: collapse; margin: 20px 0; }
    th, td { border: 1px solid #ddd; padding: 10px; text-align: left; }
    th { background: #f8f8f8; }
</style>
`;

runAsyncSkill('pdf-composer', async () => {
    validateFilePath(argv.input, 'input markdown');
    const mdContent = fs.readFileSync(argv.input, 'utf8');
    const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head><meta charset="UTF-8">${CSS_STYLE}</head>
    <body>
        ${marked.parse(mdContent)}
    </body>
    </html>
    `;

    const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.setContent(htmlContent, { waitUntil: 'networkidle0' });
    await page.pdf({
        path: argv.out,
        format: 'A4',
        printBackground: true,
        margin: { top: '20mm', bottom: '20mm', left: '20mm', right: '20mm' }
    });

    await browser.close();
    return { output: argv.out };
});