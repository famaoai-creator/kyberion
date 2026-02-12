#!/usr/bin/env node
const fs = require('fs');
const yaml = require('js-yaml');
const Papa = require('papaparse');
const { runSkill } = require('@agent/core');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');
const { validateFilePath } = require('../../scripts/lib/validators.cjs');
const { safeWriteFile } = require('../../scripts/lib/secure-io.cjs');

const argv = createStandardYargs()
    .option('input', { alias: 'i', type: 'string', demandOption: true, description: 'Input file path (.json, .yaml, .csv)' })
    .option('to', { alias: 'F', type: 'string', choices: ['json', 'yaml', 'csv'], demandOption: true, description: 'Target format' })
    .option('out', { alias: 'o', type: 'string', description: 'Output file path (optional)' })
    .argv;

runSkill('data-transformer', () => {
    const inputPath = validateFilePath(argv.input, 'input');
    const content = fs.readFileSync(inputPath, 'utf8');
    let data;

    try {
        // Auto-detect input format
        if (argv.input.endsWith('.json')) data = JSON.parse(content);
        else if (argv.input.endsWith('.yaml') || argv.input.endsWith('.yml')) data = yaml.load(content);
        else if (argv.input.endsWith('.csv')) data = Papa.parse(content, { header: true, dynamicTyping: true }).data;
        else throw new Error("Unsupported input format. Please use .json, .yaml, or .csv");
    } catch (err) {
        throw new Error(`Failed to parse input file: ${err.message}`);
    }

    let output = '';
    try {
        switch (argv.to) {
            case 'json': output = JSON.stringify(data, null, 2); break;
            case 'yaml': output = yaml.dump(data); break;
            case 'csv': output = Papa.unparse(data); break;
        }
    } catch (err) {
        throw new Error(`Failed to convert to ${argv.to}: ${err.message}`);
    }

    if (argv.out) {
        safeWriteFile(argv.out, output);
        return { 
            message: `Successfully transformed to ${argv.to}`,
            output: argv.out, 
            format: argv.to, 
            size: output.length 
        };
    } else {
        return { 
            format: argv.to, 
            content: output 
        };
    }
});
