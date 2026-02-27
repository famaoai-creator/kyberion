import '@agent/core/secure-io'; // Enforce security boundaries
import { runSkill } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { generatePersonas } from './lib.js';

const argv = createStandardYargs()
  .option('count', { alias: 'n', type: 'number', default: 3 })
  .option('product', { alias: 'p', type: 'string', default: 'SaaS app' }).parseSync();

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkill('synthetic-user-persona', () => {
    const personas = generatePersonas(argv.count as number, argv.product as string);
    return { product: argv.product, personas };
  });
}
