#!/usr/bin/env node
const fs = require('fs');
const yaml = require('js-yaml');
const Papa = require('papaparse');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const argv = yargs(hideBin(process.argv))
    .option('input', { alias: 'i', type: 'string', demandOption: true })
    .option('to', { alias: 't', type: 'string', choices: ['json', 'yaml', 'csv'], demandOption: true })
    .option('out', { alias: 'o', type: 'string' })
    .argv;

try {
    const content = fs.readFileSync(argv.input, 'utf8');
    let data;

    // Auto-detect input format
    if (argv.input.endsWith('.json')) data = JSON.parse(content);
    else if (argv.input.endsWith('.yaml') || argv.input.endsWith('.yml')) data = yaml.load(content);
    else if (argv.input.endsWith('.csv')) data = Papa.parse(content, { header: true, dynamicTyping: true }).data;
    else throw new Error("Unknown input format. Use .json, .yaml, or .csv");

    let output = '';
    switch (argv.to) {
        case 'json': output = JSON.stringify(data, null, 2); break;
        case 'yaml': output = yaml.dump(data); break;
        case 'csv': output = Papa.unparse(data); break;
    }

    if (argv.out) {
        fs.writeFileSync(argv.out, output);
        console.log(`Converted to ${argv.to}: ${argv.out}`);
    } else {
        console.log(output);
    }
} catch (e) {
    console.error("Error:", e.message);
    process.exit(1);
}