#!/usr/bin/env node
const fs = require('fs');
const Mustache = require('mustache');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const argv = yargs(hideBin(process.argv))
    .option('template', { alias: 't', type: 'string', demandOption: true })
    .option('data', { alias: 'd', type: 'string', demandOption: true })
    .option('out', { alias: 'o', type: 'string' })
    .argv;

try {
    const template = fs.readFileSync(argv.template, 'utf8');
    const dataContent = fs.readFileSync(argv.data, 'utf8');
    const data = JSON.parse(dataContent);

    const output = Mustache.render(template, data);

    if (argv.out) {
        fs.writeFileSync(argv.out, output);
        console.log(`Rendered to: ${argv.out}`);
    } else {
        console.log(output);
    }
} catch (e) {
    console.error("Error:", e.message);
    process.exit(1);
}