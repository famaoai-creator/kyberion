import * as path from 'path';
import { runSkill } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { draftPR } from './lib.js';

const argv = createStandardYargs().option('dir', {
  alias: 'd',
  type: 'string',
  default: '.',
  description: 'Git repository directory',
}).argv;

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkill('pr-architect', () => {
    const repoDir = path.resolve((argv.dir as string) || '.');
    return draftPR(repoDir);
  });
}
