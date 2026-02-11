#!/usr/bin/env node
const fs = require('fs');
const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');
const { validateFilePath, requireArgs } = require('../../scripts/lib/validators.cjs');

const argv = createStandardYargs()
  .option('input', { alias: 'i', type: 'string', describe: 'Path to requirements document', demandOption: true })
  .option('standard', { alias: 's', type: 'string', choices: ['ipa', 'ieee', 'agile'], default: 'ipa', describe: 'Standard checklist to score against' })
  .argv;

// --- Checklist definitions ---

const CHECKLISTS = {
  ipa: [
    { name: 'scope', keywords: ['scope', 'objective', 'goal', 'purpose', 'target', 'boundary', 'boundaries'] },
    { name: 'stakeholders', keywords: ['stakeholder', 'user', 'actor', 'role', 'customer', 'client', 'sponsor', 'owner'] },
    { name: 'functional requirements', keywords: ['functional requirement', 'function', 'feature', 'use case', 'user story', 'capability', 'shall'] },
    { name: 'non-functional requirements', keywords: ['non-functional', 'nonfunctional', 'performance', 'reliability', 'availability', 'scalability', 'security', 'maintainability', 'usability'] },
    { name: 'constraints', keywords: ['constraint', 'limitation', 'restriction', 'assumption', 'dependency', 'prerequisite'] },
    { name: 'glossary', keywords: ['glossary', 'definition', 'terminology', 'term', 'acronym', 'abbreviation'] },
    { name: 'acceptance criteria', keywords: ['acceptance criteria', 'acceptance test', 'done', 'definition of done', 'verification', 'validation', 'success criteria'] },
  ],
  ieee: [
    { name: 'introduction', keywords: ['introduction', 'purpose', 'scope', 'overview', 'document conventions'] },
    { name: 'overall description', keywords: ['overall description', 'product perspective', 'product functions', 'user characteristics', 'operating environment'] },
    { name: 'external interfaces', keywords: ['external interface', 'user interface', 'hardware interface', 'software interface', 'communication interface'] },
    { name: 'system features', keywords: ['system feature', 'functional requirement', 'feature', 'use case', 'stimulus', 'response'] },
    { name: 'non-functional requirements', keywords: ['non-functional', 'performance', 'safety', 'security', 'reliability', 'availability'] },
    { name: 'data requirements', keywords: ['data requirement', 'data model', 'entity', 'database', 'schema', 'data dictionary'] },
    { name: 'appendices', keywords: ['appendix', 'appendices', 'glossary', 'index', 'reference'] },
  ],
  agile: [
    { name: 'user stories', keywords: ['user story', 'as a', 'i want', 'so that', 'story', 'epic'] },
    { name: 'acceptance criteria', keywords: ['acceptance criteria', 'given', 'when', 'then', 'scenario', 'done'] },
    { name: 'personas', keywords: ['persona', 'user type', 'actor', 'role', 'stakeholder', 'archetype'] },
    { name: 'priority', keywords: ['priority', 'must have', 'should have', 'could have', 'moscow', 'backlog', 'sprint'] },
    { name: 'definition of done', keywords: ['definition of done', 'done', 'complete', 'ready', 'dod'] },
    { name: 'non-functional requirements', keywords: ['non-functional', 'performance', 'scalability', 'security', 'quality attribute'] },
    { name: 'constraints', keywords: ['constraint', 'limitation', 'budget', 'timeline', 'technical debt', 'dependency'] },
  ],
};

/**
 * Check if a document section is present by searching for keywords.
 * @param {string} content - Document content (lowercased)
 * @param {Object} checkItem - Checklist item with name and keywords
 * @returns {{ name: string, passed: boolean, detail: string }}
 */
function evaluateCheck(content, checkItem) {
  const foundKeywords = checkItem.keywords.filter(kw => content.includes(kw.toLowerCase()));
  const passed = foundKeywords.length > 0;

  let detail;
  if (passed) {
    detail = `Found keywords: ${foundKeywords.join(', ')}`;
  } else {
    detail = `No keywords found. Expected one of: ${checkItem.keywords.join(', ')}`;
  }

  return {
    name: checkItem.name,
    passed,
    detail,
  };
}

// --- Main ---

runSkill('requirements-wizard', () => {
  requireArgs(argv, ['input']);

  const inputPath = validateFilePath(argv.input, 'requirements document');
  const standard = argv.standard || 'ipa';

  const checklist = CHECKLISTS[standard];
  if (!checklist) {
    throw new Error(`Unknown standard: ${standard}. Supported: ${Object.keys(CHECKLISTS).join(', ')}`);
  }

  // Read the document
  const rawContent = fs.readFileSync(inputPath, 'utf8');
  const content = rawContent.toLowerCase();

  // Evaluate each check
  const checks = checklist.map(item => evaluateCheck(content, item));
  const passedChecks = checks.filter(c => c.passed).length;
  const totalChecks = checks.length;
  const score = totalChecks > 0 ? Math.round((passedChecks / totalChecks) * 100) : 0;

  // Generate recommendations for failed checks
  const recommendations = checks
    .filter(c => !c.passed)
    .map(c => `Add a "${c.name}" section to improve document completeness.`);

  return {
    standard,
    score,
    totalChecks,
    passedChecks,
    checks,
    recommendations,
  };
});
