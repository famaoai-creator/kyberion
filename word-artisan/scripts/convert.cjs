#!/usr/bin/env node
/**
 * word-artisan/scripts/convert.cjs
 * Data-Driven Word Renderer with Master Specs
 */

const fs = require('fs');
const path = require('path');
const { marked } = require('marked');
const HTMLtoDOCX = require('html-to-docx');
const { runSkillAsync } = require('@agent/core');
const { safeWriteFile } = require('../../scripts/lib/secure-io.cjs');
const { requireArgs, validateFilePath } = require('@agent/core/validators');

runSkillAsync('word-artisan', async () => {
    const argv = requireArgs(['input', 'out']);
    validateFilePath(argv.input, 'input file');

    // 1. Load Master Specs
    const specsPath = path.resolve(__dirname, '../../knowledge/standards/design/word-master-specs.json');
    const specs = JSON.parse(fs.readFileSync(specsPath, 'utf8'));
    const t = specs.typography;

    // 2. Process Content
    const md = fs.readFileSync(argv.input, 'utf8');
    const htmlBody = marked.parse(md);

    const fullHtml = `<!DOCTYPE html>
    <html lang="ja">
    <head>
      <meta charset="UTF-8">
      <style>
        body { font-family: ${t.body.font}, serif; font-size: ${t.body.size}pt; line-height: ${t.body.line_height}; color: ${t.body.color}; }
        h1 { font-size: ${t.heading_1.size}pt; text-align: ${t.heading_1.alignment}; color: ${t.heading_1.color}; }
        h2 { font-size: ${t.heading_2.size}pt; border-bottom: ${t.heading_2.border_bottom}; color: ${t.heading_2.color}; margin-top: 30px; }
        table { width: 100%; border-collapse: collapse; }
        th { background-color: ${specs.table_style.header_bg}; border: 1px solid ${specs.table_style.border_color}; padding: 8px; }
        td { border: 1px solid ${specs.table_style.border_color}; padding: 8px; }
      </style>
    </head>
    <body>${htmlBody}</body>
    </html>`;

    // 3. Generate DOCX
    const fileBuffer = await HTMLtoDOCX(fullHtml, null, {
        ...specs.layout,
        fontSize: t.body.size * 2
    });

    safeWriteFile(argv.out, fileBuffer);
    console.log(`[Word] Rendered with Master '${specs.master_name}' to ${argv.out}`);

    return { status: 'success', output: argv.out, master: specs.master_name };
});
