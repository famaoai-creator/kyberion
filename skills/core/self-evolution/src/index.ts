import '@agent/core/secure-io'; // Enforce security boundaries
import { runAsyncSkill } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { refineSelf } from './lib.js';

const argv = createStandardYargs()
  .option('target', { alias: 't', type: 'string', default: 'GEMINI.md' })
  .option('reason', { alias: 'r', type: 'string', demandOption: true })
  .parseSync();

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runAsyncSkill('self-evolution', async () => {
    return await refineSelf(argv.target as string, argv.reason as string);
  });
}
