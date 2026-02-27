import path from 'path';
import { runSkill } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { analyzeDependencies } from './lib.js';
import * as fs from 'fs';

const argv = createStandardYargs()
  .option('dir', {
    alias: 'd',
    type: 'string',
    default: '.',
    description: 'Project directory containing package.json',
  })
  .option('out', {
    alias: 'o',
    type: 'string',
    description: 'Output file path',
  })
  .check((parsed: any) => {
    const resolved = path.resolve(parsed.dir as string);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Directory not found: ${resolved}`);
    }
    return true;
  })
  .help().argv;

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkill('dependency-lifeline', () => {
    const dir = path.resolve((argv.dir as string) || '.');
    const out = argv.out as string | undefined;
    return analyzeDependencies(dir, out);
  });
}
