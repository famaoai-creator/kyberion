#!/usr/bin/env node
const Ajv = require('ajv');
const { runSkill } = require('@agent/core');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');
const { readJsonFile } = require('../../scripts/lib/validators.cjs');

const ajv = new Ajv({ allErrors: true });
const argv = createStandardYargs()
  .option('input', {
    alias: 'i',
    type: 'string',
    demandOption: true,
    description: 'JSON data to validate',
  })
  .option('schema', {
    alias: 's',
    type: 'string',
    demandOption: true,
    description: 'JSON Schema file path',
  }).argv;

runSkill('schema-validator', () => {
  const data = readJsonFile(argv.input, 'input data');
  const schema = readJsonFile(argv.schema, 'schema');

  const validate = ajv.compile(schema);
  const valid = validate(data);

  if (valid) {
    return {
      valid: true,
      message: 'Validation successful',
      schema: argv.schema,
    };
  } else {
    return {
      valid: false,
      message: 'Validation failed',
      errors: validate.errors,
    };
  }
});
