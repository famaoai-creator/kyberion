import { safeWriteFile, safeReadFile } from '@agent/core/secure-io';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runSkill } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { getAllFiles } from '@agent/core/fs-utils';
import { scanForDataFlows } from './lib.js';

const argv = createStandardYargs().option('dir', { alias: 'd', type: 'string', default: '.' }).parseSync();

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkill('data-lineage-guardian', () => {
    const targetDir = path.resolve(argv.dir as string);
    const allFiles = getAllFiles(targetDir, { maxDepth: 4 });
    const results: any[] = [];

    for (const full of allFiles) {
      if (!['.js', '.ts', '.py'].includes(path.extname(full))) continue;
      try {
        const content = safeReadFile(full, 'utf8');
        results.push(...scanForDataFlows(content, path.relative(targetDir, full)));
      } catch {}
    }

    return { directory: targetDir, sources: results };
  });
}
