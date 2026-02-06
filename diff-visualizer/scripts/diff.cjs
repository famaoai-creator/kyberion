#!/usr/bin/env node
const fs = require('fs');
const Diff = require('diff');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const argv = yargs(hideBin(process.argv))
    .option('old', { alias: 'a', type: 'string', demandOption: true })
    .option('new', { alias: 'b', type: 'string', demandOption: true })
    .option('out', { alias: 'o', type: 'string' })
    .argv;

try {
    const oldText = fs.readFileSync(argv.old, 'utf8');
    const newText = fs.readFileSync(argv.new, 'utf8');

    const diff = Diff.createTwoFilesPatch(
        argv.old,
        argv.new,
        oldText,
        newText,
        'Old File',
        'New File'
    );

    if (argv.out) {
        fs.writeFileSync(argv.out, diff);
        console.log(`Diff generated: ${argv.out}`);
    } else {
        console.log(diff);
    }
} catch (e) {
    console.error("Error:", e.message);
    process.exit(1);
}