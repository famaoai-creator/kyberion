import { runSkillAsync } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { runYamlScenario } from './lib.js';
import { execSync } from 'node:child_process';
import * as path from 'node:path';

const argvBuilder = createStandardYargs().option('scenario', {
  alias: 's',
  type: 'string',
  required: true,
});

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkillAsync('browser-navigator', async () => {
    const argv = await argvBuilder.argv;
    const scenarioPath = argv.scenario as string;

    if (scenarioPath.endsWith('.yaml') || scenarioPath.endsWith('.yml')) {
      const result = await runYamlScenario(path.resolve(process.cwd(), scenarioPath));
      return result;
    } else {
      const output = execSync('npx playwright test "' + scenarioPath + '" --reporter=json', {
        cwd: process.cwd(),
        encoding: 'utf8',
      });
      return { result: 'completed', output: JSON.parse(output) };
    }
  });
}
