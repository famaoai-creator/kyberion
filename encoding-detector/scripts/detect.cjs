#!/usr/bin/env node
const fs = require('fs');
const jschardet = require('jschardet');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const argv = yargs(hideBin(process.argv))
    .option('input', { alias: 'i', type: 'string', demandOption: true })
    .argv;

try {
    const buffer = fs.readFileSync(argv.input);
    const result = jschardet.detect(buffer);
    
    // Check line endings
    const content = buffer.toString();
    let lineEnding = 'unknown';
    if (content.includes('\r\n')) lineEnding = 'CRLF';
    else if (content.includes('\n')) lineEnding = 'LF';
    else if (content.includes('\r')) lineEnding = 'CR';

    console.log(JSON.stringify({ ...result, lineEnding }));
} catch (e) {
    console.error(JSON.stringify({ error: e.message }));
    process.exit(1);
}