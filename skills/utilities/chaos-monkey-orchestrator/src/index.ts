import { safeWriteFile, safeReadFile } from '@agent/core/secure-io';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runAsyncSkill } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { createChaosConfig, ChaosConfig, startFisExperiment } from './lib.js';

const argv = createStandardYargs()
  .option('target', { alias: 't', type: 'string' })
  .option('mode', {
    alias: 'm',
    type: 'string',
    choices: ['latency', 'error', 'memory-spike', 'aws-fis'],
    default: 'latency',
  })
  .option('intensity', { type: 'number', default: 0.5 })
  .option('aws-fis-template', { alias: 'f', type: 'string', describe: 'AWS FIS Template ID' })
  .parseSync();

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runAsyncSkill('chaos-monkey-orchestrator', async () => {
    const configPath = path.resolve(process.cwd(), 'work/chaos-config.json');
    let fisExperimentId: string | undefined;

    if (argv.mode === 'aws-fis' && argv['aws-fis-template']) {
      fisExperimentId = await startFisExperiment(argv['aws-fis-template'] as string);
    }

    const config = createChaosConfig(
      argv.target as string,
      argv.mode as ChaosConfig['mode'],
      argv.intensity as number,
      fisExperimentId
    );

    if (!fs.existsSync(path.dirname(configPath))) {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
    }
    safeWriteFile(configPath, JSON.stringify(config, null, 2));

    return { status: 'chaos_deployed', config };
  });
}
