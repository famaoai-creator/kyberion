import * as path from 'node:path';
import { runSkillAsync } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { getAllFiles } from '@agent/core/fs-utils';
import { getRecentChanges } from './lib.js';

const argv = createStandardYargs()
  .option('dir', { alias: 'd', type: 'string', default: '.' })
  .option('since', { alias: 's', type: 'string', default: '7 days ago' }).argv;

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkillAsync('doc-sync-sentinel', async () => {
    const rootDir = path.resolve(argv.dir as string);
    const changes = getRecentChanges(rootDir, argv.since as string);
    const docs = getAllFiles(rootDir).filter((f) => f.endsWith('.md'));

    return {
      directory: rootDir,
      changedFiles: changes.length,
      docFiles: docs.length,
    };
  });
}
