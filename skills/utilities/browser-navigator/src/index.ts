import { runSkillAsync } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { runScenario } from './lib.js';
import { execSync } from 'node:child_process';
import * as path from 'node:path';

const argvBuilder = createStandardYargs().option('scenario', {
  alias: 's',
  type: 'string',
  required: true,
});

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkillAsync('browser-navigator', async () => {
    const argv = await argvBuilder.parseSync();
    const scenarioPath = argv.scenario as string;

    const result = await runScenario(path.resolve(process.cwd(), scenarioPath));
    return result;
  });
}
