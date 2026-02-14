#!/usr/bin/env node
const fs = require('fs');
const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');
const { validateFilePath, readJsonFile } = require('../../scripts/lib/validators.cjs');

const argv = createStandardYargs()
  .option('input', { alias: 'i', type: 'string', demandOption: true })
  .option('criteria', {
    alias: 'c',
    type: 'string',
    description: 'JSON file with required keywords',
  }).argv;

runSkill('completeness-scorer', () => {
  const inputPath = validateFilePath(argv.input, 'input');
  const content = fs.readFileSync(inputPath, 'utf8');
  let score = 100;
  const issues = [];

  // Check 1: Empty content
  if (!content.trim()) {
    score = 0;
    issues.push('Content is empty');
  }

  // Check 2: TODOs
  const todoCount = (content.match(/TODO/g) || []).length;
  if (todoCount > 0) {
    score -= todoCount * 5;
    issues.push(`Found ${todoCount} TODOs`);
  }

  // Check 3: Required Keywords (if criteria provided)
  if (argv.criteria) {
    const criteria = readJsonFile(argv.criteria, 'criteria');
    if (criteria.required) {
      criteria.required.forEach((keyword) => {
        if (!content.includes(keyword)) {
          score -= 10;
          issues.push(`Missing keyword: ${keyword}`);
        }
      });
    }
  }

  return { score: Math.max(0, score), issues };
});
