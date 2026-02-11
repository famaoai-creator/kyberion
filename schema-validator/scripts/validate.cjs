#!/usr/bin/env node
const Ajv = require('ajv');
const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');
const { readJsonFile } = require('../../scripts/lib/validators.cjs');

const ajv = new Ajv();
const argv = createStandardYargs()
    .option('input', { alias: 'i', type: 'string', demandOption: true })
    .option('schema', { alias: 's', type: 'string', demandOption: true })
    .argv;

runSkill('schema-validator', () => {
    const data = readJsonFile(argv.input, 'input data');
    const schema = readJsonFile(argv.schema, 'schema');

    const validate = ajv.compile(schema);
    const valid = validate(data);

    if (valid) {
        return { valid: true };
    } else {
        return { valid: false, errors: validate.errors };
    }
});
