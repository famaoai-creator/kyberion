import { runAsyncSkill } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { safeWriteFile } from '@agent/core/secure-io';
import { extractFromDB } from './lib.js';

const argv = createStandardYargs()
  .option('db', { alias: 'd', type: 'string', demandOption: true })
  .option('query', { alias: 'q', type: 'string', default: 'SELECT * FROM sqlite_master' })
  .option('out', { alias: 'o', type: 'string' }).argv;

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runAsyncSkill('db-extractor', async () => {
    const rows = await extractFromDB(argv.db as string, argv.query as string);
    if (argv.out) {
      safeWriteFile(argv.out as string, JSON.stringify(rows, null, 2));
      return { output: argv.out, rowCount: rows.length };
    }
    return { rows, rowCount: rows.length };
  });
}
