#!/usr/bin/env node
/**
 * test-viewpoint-analyst/scripts/analyze.cjs
 * Pure Engine: Requirement to Test Case Transformer
 */

const fs = require('fs');
const path = require('path');
const { runSkill } = require('@agent/core');
const { safeWriteFile } = require('../../scripts/lib/secure-io.cjs');
const { requireArgs } = require('@agent/core/validators');

runSkill('test-viewpoint-analyst', () => {
  const argv = requireArgs(['input', 'out']);
  const reqAdf = JSON.parse(fs.readFileSync(path.resolve(argv.input), 'utf8'));

  const testCases = [];

  reqAdf.requirements.forEach((req) => {
    // AI Logic: Generate standard viewpoints for each requirement
    testCases.push({
      id: `TC-${req.id}-01`,
      ref: req.id,
      category: 'Normal',
      scenario: `Valid application of ${req.title}`,
      expected: 'Success',
    });

    if (req.rule.includes('Threshold') || req.rule.includes('$') || req.rule.includes('%')) {
      testCases.push({
        id: `TC-${req.id}-02`,
        ref: req.id,
        category: 'Boundary',
        scenario: `Value at the exact threshold for ${req.title}`,
        expected: 'Borderline Handling',
      });
    }
  });

  const testAdf = {
    project: reqAdf.project,
    test_cases: testCases,
  };

  fs.mkdirSync(path.dirname(argv.out), { recursive: true });
  safeWriteFile(path.resolve(argv.out), JSON.stringify(testAdf, null, 2));

  return { status: 'success', testCaseCount: testCases.length, output: argv.out };
});
