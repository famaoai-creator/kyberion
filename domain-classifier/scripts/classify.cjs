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

const rulesPath = path.join(__dirname, '../../knowledge/classifiers/domain-rules.yml');
const rulesData = yaml.load(fs.readFileSync(rulesPath, 'utf8'));
const DOMAINS = rulesData.categories;

runSkill('domain-classifier', () => {
  return classifyFile(argv.input, DOMAINS, { resultKey: rulesData.resultKey });
});
