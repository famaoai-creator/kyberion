#!/usr/bin/env node
const fs = require('fs');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const argv = yargs(hideBin(process.argv))
    .option('input', { alias: 'i', type: 'string', demandOption: true })
    .option('glossary', { alias: 'g', type: 'string', demandOption: true })
    .option('out', { alias: 'o', type: 'string' })
    .argv;

try {
    let content = fs.readFileSync(argv.input, 'utf8');
    const glossary = JSON.parse(fs.readFileSync(argv.glossary, 'utf8'));

    for (const [term, def] of Object.entries(glossary)) {
        const regex = new RegExp(`\b${term}\b`, 'g');
        content = content.replace(regex, `${term} (${def})`);
    }

    if (argv.out) {
        fs.writeFileSync(argv.out, content);
        console.log("Resolved terms to: " + argv.out);
    } else {
        console.log(content);
    }
} catch (e) { console.error(JSON.stringify({ error: e.message })); }
