#!/usr/bin/env node
const fs = require('fs');
const Ajv = require('ajv');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const ajv = new Ajv();
const argv = yargs(hideBin(process.argv))
    .option('input', { alias: 'i', type: 'string', demandOption: true })
    .option('schema', { alias: 's', type: 'string', demandOption: true })
    .argv;

try {
    const data = JSON.parse(fs.readFileSync(argv.input, 'utf8'));
    const schema = JSON.parse(fs.readFileSync(argv.schema, 'utf8'));

    const validate = ajv.compile(schema);
    const valid = validate(data);

    if (valid) {
        console.log(JSON.stringify({ valid: true }));
    } else {
        console.log(JSON.stringify({ valid: false, errors: validate.errors }));
    }
} catch (e) {
    console.error(JSON.stringify({ error: e.message }));
    process.exit(1);
}