#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { runAsyncSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { loadProjectStandards } = require('../../scripts/lib/config-loader.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');
const { logger } = require('../../scripts/lib/core.cjs');

const argv = createStandardYargs()
    .option('input', { alias: 'i', type: 'string', demandOption: true, description: 'Input file' })
    .argv;

const standards = loadProjectStandards();

runAsyncSkill('{{SKILL_NAME}}', async () => {
    const inputPath = path.resolve(argv.input);
    
    // --- Architecture Standard: Handle Orphaned Requests ---
    // In scenarios where this skill is called via an HTTP-based BFF, 
    // we ensure logging completes even if the client disconnects.
    let isAborted = false;
    process.on('SIGTERM', () => { isAborted = true; }); // Example for container environments

    try {
        logger.info(`Starting {{SKILL_NAME}} for: ${argv.input}`);
        
        // TODO: Implement skill logic here
        const content = fs.readFileSync(inputPath, 'utf8');
        const result = { 
            input: argv.input, 
            processed: true,
            length: content.length 
        };

        if (isAborted) {
            logger.warn(`{{SKILL_NAME}} completed after process received abort signal. Result may not reach caller.`);
        }

        return result;
    } catch (error) {
        logger.error(`{{SKILL_NAME}} failed: ${error.message}`);
        throw error;
    }
});