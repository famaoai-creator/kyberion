#!/usr/bin/env node
const fs = require('fs');
const { marked } = require('marked');
const HTMLtoDOCX = require('html-to-docx');
const { runAsyncSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');

const argv = createStandardYargs()
    .option('input', { alias: 'i', type: 'string', demandOption: true })
    .option('out', { alias: 'o', type: 'string', demandOption: true })
    .argv;

runAsyncSkill('word-artisan', async () => {
    const md = fs.readFileSync(argv.input, 'utf8');
    const htmlContent = marked.parse(md);

    const fullHtml = `<!DOCTYPE html>
    <html lang="ja">
    <head>
      <meta charset="UTF-8">
      <style>
        body { font-family: 'MS Mincho', 'Times New Roman', serif; font-size: 10.5pt; line-height: 1.5; }
        h1 { font-size: 24pt; text-align: center; margin-top: 100pt; margin-bottom: 50pt; color: #1f4e78; }
        h2 { font-size: 18pt; border-bottom: 2px solid #1f4e78; padding-bottom: 5px; margin-top: 30px; color: #2e75b5; page-break-before: always; }
        h3 { font-size: 14pt; border-left: 10px solid #2e75b5; padding-left: 10px; margin-top: 20px; color: #1f4e78; }
        table { width: 100%; border-collapse: collapse; margin-bottom: 15px; }
        th { background-color: #deeaf6; border: 1px solid #4472c4; padding: 8px; font-weight: bold; }
        td { border: 1px solid #4472c4; padding: 8px; }
        .toc { font-size: 12pt; line-height: 2; }
      </style>
    </head>
    <body>
      ${htmlContent}
    </body>
    </html>`;

    const fileBuffer = await HTMLtoDOCX(fullHtml, null, {
        table: { row: { cantSplit: true } },
        footer: true,
        pageNumber: true,
        header: true,
        font: 'MS Mincho',
        fontSize: 21, // 10.5pt * 2
        margins: { top: 1440, right: 1440, bottom: 1440, left: 1440 }
    });

    fs.writeFileSync(argv.out, fileBuffer);
    return { output: argv.out, size: fileBuffer.length };
});
