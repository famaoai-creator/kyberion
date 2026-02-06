#!/usr/bin/env node
const fs = require('fs');
const markdownpdf = require('markdown-pdf');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const argv = yargs(hideBin(process.argv))
    .option('input', { alias: 'i', type: 'string', demandOption: true })
    .option('out', { alias: 'o', type: 'string', demandOption: true })
    .argv;

try {
    markdownpdf()
        .from(argv.input)
        .to(argv.out, function () {
            console.log(`Generated PDF: ${argv.out}`);
        });
} catch (e) {
    console.error("Error:", e.message);
    process.exit(1);
}