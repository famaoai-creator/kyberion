import * as fs from 'node:fs';
import * as path from 'node:path';
import { runSkill } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { createChaosConfig, ChaosConfig } from './lib.js';

const argv = createStandardYargs()
  .option('target', { alias: 't', type: 'string' })
  .option('mode', {
    alias: 'm',
    type: 'string',
    choices: ['latency', 'error', 'memory-spike'],
    default: 'latency',
  })
  .option('intensity', { type: 'number', default: 0.5 })
  .parseSync();

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkill('chaos-monkey-orchestrator', () => {
    const configPath = path.resolve(process.cwd(), 'work/chaos-config.json');
    const config = createChaosConfig(
      argv.target as string,
      argv.mode as ChaosConfig['mode'],
      argv.intensity as number
    );

    if (!fs.existsSync(path.dirname(configPath))) {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
    }
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    return { status: 'chaos_deployed', config };
  });
}
