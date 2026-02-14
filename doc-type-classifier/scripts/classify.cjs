#!/usr/bin/env node
/**
 * doc-type-classifier/scripts/classify.cjs
 * SCAP-Aligned Intelligent Classifier
 */

const fs = require('fs');
const path = require('path');
const { runSkill } = require('@agent/core');
const { requireArgs } = require('@agent/core/validators');

function classify(content, categories) {
  let bestMatch = 'Unknown';
  let maxMatches = 0;

  categories.forEach((cat) => {
    let matches = 0;
    cat.keywords.forEach((k) => {
      if (content.toLowerCase().includes(k)) matches++;
    });
    if (matches > maxMatches) {
      maxMatches = matches;
      bestMatch = cat.name;
    }
  });
  return bestMatch;
}

runSkill('doc-type-classifier', () => {
  const argv = requireArgs(['input']);
  const inputPath = path.resolve(argv.input);
  const rulesPath = path.resolve(
    __dirname,
    '../../knowledge/skills/doc-type-classifier/rules.json'
  );

  if (!fs.existsSync(inputPath)) throw new Error(`Input not found: ${inputPath}`);
  const rules = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
  const content = fs.readFileSync(inputPath, 'utf8');

  const result = classify(content, rules.categories);

  return {
    file: path.basename(inputPath),
    scap_layer: result,
    confidence: result === 'Unknown' ? 'low' : 'high',
  };
});
