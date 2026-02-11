#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');

const argv = createStandardYargs()
  .option('input', { alias: 'i', type: 'string', demandOption: true, description: 'Path to JSON problem description' })
  .option('out', { alias: 'o', type: 'string', description: 'Output file path' })
  .argv;

function analyzeGap(problem, existingSkills) {
  const lower = (problem.description || '').toLowerCase();
  const covered = existingSkills.filter(s => lower.includes(s.name.replace(/-/g, ' ')) || lower.includes(s.name));
  const gap = covered.length === 0;
  return { gap, coveredBy: covered.map(s => s.name), needsNewSkill: gap };
}

runSkill('autonomous-skill-designer', () => {
  const problem = JSON.parse(fs.readFileSync(argv.input, 'utf8'));
  const skillsIndex = JSON.parse(fs.readFileSync(path.join(__dirname, '../../knowledge/orchestration/global_skill_index.json'), 'utf8'));
  
  const gap = analyzeGap(problem, skillsIndex.skills);
  
  if (argv.out) {
    fs.writeFileSync(argv.out, JSON.stringify(gap, null, 2));
  }
  
  return gap;
});