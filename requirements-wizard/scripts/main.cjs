#!/usr/bin/env node
/**
 * requirements-wizard/scripts/main.cjs
 * Knowledge-Driven Requirements Auditor
 */

const fs = require('fs');
const path = require('path');
const { runSkill } = require('@agent/core');
const { requireArgs } = require('@agent/core/validators');

runSkill('requirements-wizard', () => {
  const argv = requireArgs(['input']);
  const inputPath = path.resolve(argv.input);
  const standardPath = argv.standard ? path.resolve(argv.standard) : null;

  if (!fs.existsSync(inputPath)) throw new Error(`Input not found: ${inputPath}`);

  const adf = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const contentText = JSON.stringify(adf).toLowerCase();

  let checklist = [];

  // 1. Load Standard Knowledge
  if (standardPath && fs.existsSync(standardPath)) {
    const standardContent = fs.readFileSync(standardPath, 'utf8');
    // Extract H2 and H3 as audit items
    const matches = standardContent.matchAll(/^###?\s+(.+)$/gm);
    for (const match of matches) {
      checklist.push(match[1].trim());
    }
  } else {
    // Fallback to basic keywords
    checklist = ['availability', 'performance', 'security', 'scalability', 'usability'];
  }

  // 2. Perform Audit
  const results = checklist.map((item) => {
    const found = contentText.includes(item.toLowerCase().split(' ')[0]); // Simple check
    return {
      criterion: item,
      status: found ? 'passed' : 'missing',
      suggestion: found ? null : `Requirement '${item}' is not clearly defined in ADF.`,
    };
  });

  const score = Math.round(
    (results.filter((r) => r.status === 'passed').length / results.length) * 100
  );

  return {
    project: adf.project_name || 'Unknown',
    score,
    audit_results: results,
    standard_used: standardPath || 'default-lite',
  };
});
