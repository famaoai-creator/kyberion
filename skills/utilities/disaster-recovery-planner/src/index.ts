import * as fs from 'node:fs';
import * as path from 'node:path';
import { runSkill } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { safeWriteFile } from '@agent/core/secure-io';
import { detectInfrastructure } from './lib.js';

const argv = createStandardYargs()
  .option('dir', { alias: 'd', type: 'string', default: '.' })
  .option('out', { alias: 'o', type: 'string' })
  .parseSync();

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkill('disaster-recovery-planner', () => {
    const targetDir = path.resolve(argv.dir as string);
    if (!fs.existsSync(targetDir)) throw new Error('Directory not found');

    const infra = detectInfrastructure(targetDir);
    const result = {
      directory: targetDir,
      infrastructure: infra,
      recommendations:
        infra.databases.length > 0 ? ['Ensure daily offsite backups'] : ['Standard backup policy'],
    };

    if (argv.out) safeWriteFile(argv.out as string, JSON.stringify(result, null, 2));
    return result;
  });
}
