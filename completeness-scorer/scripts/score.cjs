#!/usr/bin/env node
const fs = require('fs');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const argv = yargs(hideBin(process.argv))
    .option('input', { alias: 'i', type: 'string', demandOption: true })
    .option('criteria', { alias: 'c', type: 'string', description: 'JSON file with required keywords' })
    .argv;

try {
    const content = fs.readFileSync(argv.input, 'utf8');
    let score = 100;
    const issues = [];

    // Check 1: Empty content
    if (!content.trim()) {
        score = 0;
        issues.push("Content is empty");
    }

    // Check 2: TODOs
    const todoCount = (content.match(/TODO/g) || []).length;
    if (todoCount > 0) {
        score -= todoCount * 5;
        issues.push(`Found ${todoCount} TODOs`);
    }

    // Check 3: Required Keywords (if criteria provided)
    if (argv.criteria) {
        const criteria = JSON.parse(fs.readFileSync(argv.criteria, 'utf8'));
        if (criteria.required) {
            criteria.required.forEach(keyword => {
                if (!content.includes(keyword)) {
                    score -= 10;
                    issues.push(`Missing keyword: ${keyword}`);
                }
            });
        }
    }

    console.log(JSON.stringify({ score: Math.max(0, score), issues }));
} catch (e) {
    console.error(JSON.stringify({ error: e.message }));
    process.exit(1);
}