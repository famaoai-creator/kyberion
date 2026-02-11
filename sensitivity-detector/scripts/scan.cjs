#!/usr/bin/env node
const fs = require('fs');
const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');
const { validateFilePath } = require('../../scripts/lib/validators.cjs');

const argv = createStandardYargs()
    .option('input', { alias: 'i', type: 'string', demandOption: true })
    .argv;

const PII_PATTERNS = {
    'email': /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
    'ipv4': /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
    'phone_jp': /\b0\d{1,4}-\d{1,4}-\d{3,4}\b/g,
    'credit_card': /\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/g
};

runSkill('sensitivity-detector', () => {
    const inputPath = validateFilePath(argv.input, 'input');
    const content = fs.readFileSync(inputPath, 'utf8');
    const findings = {};
    let hasPII = false;

    for (const [type, regex] of Object.entries(PII_PATTERNS)) {
        const matches = content.match(regex);
        if (matches) {
            findings[type] = matches.length;
            hasPII = true;
        }
    }

    return { hasPII, findings };
});
