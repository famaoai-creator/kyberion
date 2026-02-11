#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { runSkill } = require('@gemini/core');
const { requireArgs, validateFilePath } = require('@gemini/core/validators');

runSkill('quality-scorer', () => {
    const argv = requireArgs(['input']);
    const inputPath = validateFilePath(argv.input, 'input');
    const content = fs.readFileSync(inputPath, 'utf8');

    // Load Knowledge
    const rulesPath = path.resolve(__dirname, '../../knowledge/skills/quality-scorer/rules.json');
    const { scoring_rules } = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));

    const charCount = content.length;
    const sentences = content.split(/[.?!。？！]/).filter(Boolean).length;
    const avgLen = sentences > 0 ? charCount / sentences : 0;

    let score = 100;
    const issues = [];

    if (charCount < scoring_rules.min_length.threshold) {
        score -= scoring_rules.min_length.penalty;
        issues.push(scoring_rules.min_length.message);
    }
    if (charCount > scoring_rules.max_length.threshold) {
        score -= scoring_rules.max_length.penalty;
        issues.push(scoring_rules.max_length.message);
    }
    if (avgLen > scoring_rules.avg_sentence_length.threshold) {
        score -= scoring_rules.avg_sentence_length.penalty;
        issues.push(scoring_rules.avg_sentence_length.message);
    }

    return { 
        score: Math.max(0, score), 
        metrics: { charCount, sentences, avgLen }, 
        issues 
    };
});
