import * as path from 'path';
import * as fs from 'fs';
import { runSkill } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { analyzeTestSuite } from './lib.js';

const argv = createStandardYargs()
  .option('dir', {
    alias: 'd',
    type: 'string',
    demandOption: true,
    describe: 'Path to project directory to analyze',
  })
  .check((parsed: any) => {
    const resolved = path.resolve(parsed.dir);
    if (!fs.existsSync(resolved)) {
      throw new Error('Directory not found: ' + resolved);
    }
    if (!fs.statSync(resolved).isDirectory()) {
      throw new Error('Path is not a directory: ' + resolved);
    }
    return true;
  })
  .strict()
  .help().parseSync();

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkill('test-suite-architect', () => {
    const projectDir = path.resolve(argv.dir as string);
    return analyzeTestSuite(projectDir);
  });
}
