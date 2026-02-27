import { runSkill } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as pathResolver from '@agent/core/path-resolver';
import { predict } from './lib.js';

const argv = createStandardYargs()
  .option('dir', { alias: 'd', type: 'string', default: '.' })
  .option('since', { alias: 's', type: 'string', default: '3 months ago' })
  .option('top', { alias: 't', type: 'number', default: 10 })
  .option('out', { alias: 'o', type: 'string' }).argv;

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkill('bug-predictor', () => {
    const rootDir = pathResolver.rootDir();
    const repoDir = (argv.dir as string) === '.' ? rootDir : (argv.dir as string);

    return predict(repoDir, {
      since: argv.since as string,
      top: argv.top as number,
      outPath: argv.out as string,
    });
  });
}
