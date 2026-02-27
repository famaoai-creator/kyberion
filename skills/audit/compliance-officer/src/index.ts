import * as fs from 'node:fs';
import * as path from 'node:path';
import { runSkill } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { auditCompliance } from './lib.js';

const argv = createStandardYargs().option('dir', { alias: 'd', type: 'string', default: '.' }).parseSync();

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkill('compliance-officer', () => {
    const targetDir = path.resolve(argv.dir as string);
    const patterns = [
      '.git',
      '.env',
      'package.json',
      'README.md',
      'kms.tf',
      'vault/secrets',
      'libs/core/secure-io.cjs',
    ];
    const results = auditCompliance(targetDir, patterns);

    return { directory: targetDir, results };
  });
}
