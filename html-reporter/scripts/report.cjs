#!/usr/bin/env node
const { safeWriteFile } = require('@agent/core/secure-io');
const fs = require('fs');
const { marked } = require('marked');
const { runSkill } = require('@agent/core');
const { createStandardYargs } = require('@agent/core/cli-utils');
const { validateFilePath } = require('@agent/core/validators');

const argv = createStandardYargs().option('title', {
  alias: 'title',
  type: 'string',
  default: 'Report',
}).argv;

runSkill('html-reporter', () => {
  const inputPath = validateFilePath(argv.input, 'input markdown');
  const md = fs.readFileSync(inputPath, 'utf8');
  const body = marked.parse(md);

  const html = `
<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <title>${argv.title}</title>
    <style>
        body { font-family: sans-serif; max-width: 800px; margin: 0 auto; padding: 2rem; line-height: 1.6; }
        h1, h2, h3 { color: #333; }
        code { background: #f4f4f4; padding: 0.2rem 0.4rem; border-radius: 4px; }
        pre { background: #f4f4f4; padding: 1rem; overflow-x: auto; }
        table { border-collapse: collapse; width: 100%; margin-bottom: 1rem; }
        th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
        th { background-color: #f2f2f2; }
    </style>
</head>
<body>
    ${body}
</body>
</html>`;

  safeWriteFile(argv.out, html);
  return { output: argv.out, title: argv.title, size: html.length };
});
