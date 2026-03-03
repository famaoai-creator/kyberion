import { runSkill, safeReadFile, safeWriteFile } from '@agent/core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createStandardYargs } from '@agent/core/cli-utils';
import { getAllFiles } from '@agent/core/fs-utils';
import { auditMonitoringContent } from './lib.js';

const argv = createStandardYargs().option('dir', { alias: 'd', type: 'string', default: '.' }).parseSync();

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkill('monitoring-config-auditor', () => {
    const targetDir = path.resolve(argv.dir as string);
    const allFiles = getAllFiles(targetDir, { maxDepth: 2 });
    let combinedContent = '';

    for (const f of allFiles) {
      if (['.js', '.ts', '.yml', '.json'].includes(path.extname(f))) {
        try {
          combinedContent += safeReadFile(f, { encoding: 'utf8' }) as string;
        } catch {}
      }
    }

    const results = auditMonitoringContent(combinedContent);
    return { directory: targetDir, results };
  });
}
