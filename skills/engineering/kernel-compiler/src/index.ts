import * as path from 'path';
import * as fs from 'fs';
import { runSkill } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { safeWriteFile } from '@agent/core/secure-io';
import { runCompiler } from './lib.js';

const argv = createStandardYargs()
  .option('dir', { alias: 'd', type: 'string', default: '.', description: 'Project directory' })
  .option('target', {
    alias: 't',
    type: 'string',
    default: 'node',
    choices: ['node', 'go', 'rust', 'docker'],
    description: 'Compilation target',
  })
  .option('dry-run', { type: 'boolean', default: true, description: 'Analyze without compiling' })
  .option('out', { alias: 'o', type: 'string', description: 'Output file path' })
  .help().argv;

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkill('kernel-compiler', () => {
    const targetDir = path.resolve(argv.dir as string);
    if (!fs.existsSync(targetDir)) throw new Error(`Directory not found: ${targetDir}`);

    const result = runCompiler(targetDir, argv.target as string, argv['dry-run'] as boolean);

    if (argv.out) {
      safeWriteFile(argv.out as string, JSON.stringify(result, null, 2));
    }

    return result;
  });
}
