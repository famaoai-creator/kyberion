#!/usr/bin/env node
const fs = require('fs');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const argv = yargs(hideBin(process.argv))
    .option('input', { alias: 'i', type: 'string', demandOption: true })
    .argv;

try {
    const content = fs.readFileSync(argv.input, 'utf8');
    let format = 'unknown';
    let confidence = 0.0;

    // Simple heuristic detection
    if (content.trim().startsWith('{') || content.trim().startsWith('[')) {
        try { JSON.parse(content); format = 'json'; confidence = 1.0; } catch(e) {}
    }
    
    if (format === 'unknown') {
        if (content.includes('---') || content.includes(': ')) {
             // Basic YAML check
             format = 'yaml'; confidence = 0.7;
        } else if (content.includes(',')) {
             // Basic CSV check
             const lines = content.split('\n');
             if (lines.length > 0 && lines[0].split(',').length > 1) {
                 format = 'csv'; confidence = 0.6;
             }
        }
    }

    console.log(JSON.stringify({ format, confidence }));

} catch (e) {
    console.error(JSON.stringify({ error: e.message }));
    process.exit(1);
}