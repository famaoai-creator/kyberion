import * as path from 'path';
import { runAsyncSkill } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { safeWriteFile } from '@agent/core/secure-io';
import { generateMaestroYaml } from './lib.js';

const argv = createStandardYargs()
  .option('app-id', { alias: 'a', type: 'string', demandOption: true })
  .option('scenario', { alias: 's', type: 'string', demandOption: true })
  .option('out', { alias: 'o', type: 'string' }).parseSync();

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runAsyncSkill('mobile-test-generator', async () => {
    const appId = argv['app-id'] as string;
    const scenario = argv.scenario as string;
    const outPath = (argv.out as string) || path.join(process.cwd(), `test-${Date.now()}.yaml`);

    const yamlContent = generateMaestroYaml({ appId, scenario });

    safeWriteFile(outPath, yamlContent);

    return { appId, scenario, output: outPath };
  });
}
