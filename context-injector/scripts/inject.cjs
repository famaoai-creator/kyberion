#!/usr/bin/env node
const fs = require('fs');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const argv = yargs(hideBin(process.argv))
    .option('data', { alias: 'd', type: 'string', demandOption: true })
    .option('knowledge', { alias: 'k', type: 'string', demandOption: true })
    .option('out', { alias: 'o', type: 'string' })
    .argv;

try {
    const data = JSON.parse(fs.readFileSync(argv.data, 'utf8'));
    const knowledgeContent = fs.readFileSync(argv.knowledge, 'utf8');

    data._context = data._context || {};
    data._context.injected_knowledge = knowledgeContent;

    const output = JSON.stringify(data, null, 2);
    if (argv.out) {
        fs.writeFileSync(argv.out, output);
        console.log("Injected context to: " + argv.out);
    } else {
        console.log(output);
    }
} catch (e) { console.error(JSON.stringify({ error: e.message })); }
