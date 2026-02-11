#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { classifyFile } = require('../../scripts/lib/classifier.cjs');
const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');

const argv = createStandardYargs()
    .option('input', { alias: 'i', type: 'string', demandOption: true })
    .argv;

const rulesPath = path.join(__dirname, '../../knowledge/classifiers/doc-type-rules.yml');
const rulesData = yaml.load(fs.readFileSync(rulesPath, 'utf8'));
const RULES = rulesData.categories;

runSkill('doc-type-classifier', () => {
    return classifyFile(argv.input, RULES, { resultKey: rulesData.resultKey });
});
