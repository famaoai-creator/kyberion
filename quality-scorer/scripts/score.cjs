#!/usr/bin/env node

const fs = require('fs');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const argv = yargs(hideBin(process.argv)).option('input', { alias: 'i', type: 'string' }).argv;

try {
    const content = fs.readFileSync(argv.input, 'utf8');
    
    // Metrics
    const charCount = content.length;
    const lines = content.split('\n').length;
    const sentences = content.split(/[.?!。？！]/).length;
    
    // Heuristic scoring (0-100)
    let score = 100;
    const issues = [];

    if (charCount < 50) { score -= 20; issues.push('Too short'); }
    if (charCount > 10000) { score -= 10; issues.push('Very long'); }
    
    // Avg sentence length
    const avgLen = charCount / sentences;
    if (avgLen > 100) { score -= 10; issues.push('Sentences are too long on average'); }

    console.log(JSON.stringify({ score, metrics: { charCount, lines, avgLen }, issues }));
} catch (e) { console.error(JSON.stringify({ error: e.message })); }

