import '@agent/core/secure-io'; // Enforce security boundaries
import { safeReadFile } from '@agent/core/secure-io';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runSkill } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { tailFile, validateLogStructure } from './lib.js';

const argv = createStandardYargs()
  .option('input', { alias: 'i', type: 'string', demandOption: true, description: 'Path to log file' })
  .option('lines', { alias: 'n', type: 'number', default: 100, description: 'Number of lines to tail' })
  .option('validate', { type: 'boolean', default: false, description: 'Validate JSON log structure' })
  .parseSync();

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkill('log-analyst', () => {
    const logPath = path.resolve(argv.input as string);
    if (!fs.existsSync(logPath)) {
      throw new Error(`Log file not found: ${logPath}`);
    }

    const tail = tailFile(logPath, argv.lines as number);
    
    if (argv.validate) {
      const validation = validateLogStructure(tail.content);
      return { ...tail, validation };
    }

    return tail;
  });
}
