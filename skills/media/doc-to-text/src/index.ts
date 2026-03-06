import { runSkillAsync } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { extract, ExtractionMode } from './lib.js';
import * as path from 'node:path';

const argvBuilder = createStandardYargs()
  .positional('file', {
    type: 'string',
    description: 'Path to the document to extract',
  })
  .option('mode', {
    alias: 'm',
    type: 'string',
    choices: ['content', 'aesthetic', 'metadata', 'all'],
    default: 'all',
    description: 'Extraction mode: soul (content), mask (aesthetic), or context (metadata)',
  })
  .option('out', {
    alias: 'o',
    type: 'string',
    description: 'Output JSON file path',
  });

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkillAsync('doc-to-text', async () => {
    const argv = await argvBuilder.parseSync();
    const filePath = argv.file as string || argv._[0] as string;
    const mode = argv.mode as ExtractionMode;

    if (!filePath) {
      throw new Error('Please provide a file path to extract.');
    }

    const result = await extract(path.resolve(process.cwd(), filePath), mode);

    if (argv.out) {
      const { safeWriteFile } = await import('@agent/core');
      safeWriteFile(argv.out as string, JSON.stringify(result, null, 2));
    }

    return result;
  });
}
