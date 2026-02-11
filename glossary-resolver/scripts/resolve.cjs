#!/usr/bin/env node
const fs = require('fs');
const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');
const { validateFilePath, readJsonFile } = require('../../scripts/lib/validators.cjs');

const argv = createStandardYargs()
    .option('input', { alias: 'i', type: 'string', demandOption: true })
    .option('glossary', { alias: 'g', type: 'string', demandOption: true })
    .option('out', { alias: 'o', type: 'string' })
    .argv;

runSkill('glossary-resolver', () => {
    const inputPath = validateFilePath(argv.input, 'input');
    let content = fs.readFileSync(inputPath, 'utf8');
    const glossary = readJsonFile(argv.glossary, 'glossary');

    let resolvedCount = 0;
    for (const [term, def] of Object.entries(glossary)) {
        const regex = new RegExp(`\b${term}\b`, 'g');
        const before = content;
        content = content.replace(regex, `${term} (${def})`);
        if (content !== before) resolvedCount++;
    }

    if (argv.out) {
        fs.writeFileSync(argv.out, content);
        return { output: argv.out, resolvedTerms: resolvedCount };
    } else {
        return { content, resolvedTerms: resolvedCount };
    }
});
