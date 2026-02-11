#!/usr/bin/env node

const fs = require('fs');
const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');
const { validateFilePath } = require('../../scripts/lib/validators.cjs');

const argv = createStandardYargs().option('input', { alias: 'i', type: 'string' }).argv;

runSkill('quality-scorer', () => {
    const inputPath = validateFilePath(argv.input, 'input');
    const content = fs.readFileSync(inputPath, 'utf8');

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

    return { score, metrics: { charCount, lines, avgLen }, issues };
});
