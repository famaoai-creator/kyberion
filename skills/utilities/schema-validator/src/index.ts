import '@agent/core/secure-io'; // Enforce security boundaries
import { runSkill } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { readJsonFile } from '@agent/core/validators';
import { validateData } from './lib.js';

const argv = createStandardYargs()
  .option('input', { alias: 'i', type: 'string', demandOption: true })
  .option('schema', { alias: 's', type: 'string', demandOption: true })
  .parseSync();

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkill('schema-validator', () => {
    const data = readJsonFile(argv.input as string, 'input data');
    const schema = readJsonFile(argv.schema as string, 'schema');
    return validateData(data, schema, argv.schema as string);
  });
}
