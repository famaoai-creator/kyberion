#!/usr/bin/env node
const fs = require('fs');
const { marked } = require('marked');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const argv = yargs(hideBin(process.argv))
    .option('input', { alias: 'i', type: 'string', demandOption: true })
    .option('title', { alias: 't', type: 'string', default: 'Report' })
    .option('out', { alias: 'o', type: 'string', demandOption: true })
    .argv;

try {
    const md = fs.readFileSync(argv.input, 'utf8');
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

    fs.writeFileSync(argv.out, html);
    console.log(`Generated HTML Report: ${argv.out}`);
} catch (e) {
    console.error("Error:", e.message);
    process.exit(1);
}