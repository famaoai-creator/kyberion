#!/usr/bin/env node
const fs = require('fs');
const { validateInjection, scanForConfidentialMarkers } = require('../../scripts/lib/tier-guard.cjs');
const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');
const { validateFilePath, readJsonFile } = require('../../scripts/lib/validators.cjs');

const argv = createStandardYargs()
    .option('data', { alias: 'd', type: 'string', demandOption: true })
    .option('knowledge', { alias: 'k', type: 'string', demandOption: true })
    .option('out', { alias: 'o', type: 'string' })
    .option('output-tier', { type: 'string', default: 'public', choices: ['personal', 'confidential', 'public'] })
    .argv;

runSkill('context-injector', () => {
    const data = readJsonFile(argv.data, 'data');
    const knowledgePath = validateFilePath(argv.knowledge, 'knowledge');
    const outputTier = argv['output-tier'];

    // Tier validation
    const tierCheck = validateInjection(knowledgePath, outputTier);
    if (!tierCheck.allowed) {
        throw new Error(`Tier violation: ${tierCheck.reason}`);
    }

    const knowledgeContent = fs.readFileSync(knowledgePath, 'utf8');

    // Scan for accidental confidential markers in public output
    if (outputTier === 'public') {
        const scan = scanForConfidentialMarkers(knowledgeContent);
        if (scan.hasMarkers) {
            throw new Error(
                `Confidential markers detected in knowledge file for public output: ${scan.markers.join(', ')}`
            );
        }
    }

    data._context = data._context || {};
    data._context.injected_knowledge = knowledgeContent;
    data._context.knowledge_tier = tierCheck.sourceTier;

    const output = JSON.stringify(data, null, 2);
    if (argv.out) {
        fs.writeFileSync(argv.out, output);
    }

    return { injected: true, sourceTier: tierCheck.sourceTier, outputTier };
});
