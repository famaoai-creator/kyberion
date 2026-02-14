#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { classifyFile } = require('@agent/core/classifier');
const { runSkill } = require('@agent/core');
const { createStandardYargs } = require('@agent/core/cli-utils');

const argv = createStandardYargs().option('input', {
  alias: 'i',
  type: 'string',
  demandOption: true,
}).argv;

const rulesPath = path.join(__dirname, '../../knowledge/classifiers/intent-rules.yml');
const rulesData = yaml.load(fs.readFileSync(rulesPath, 'utf8'));
const INTENTS = rulesData.categories;

runSkill('intent-classifier', () => {
  return classifyFile(argv.input, INTENTS, { resultKey: rulesData.resultKey });
});
