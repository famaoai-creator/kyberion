import { runSkillAsync } from '@agent/core';
import { orchestrate } from './lib.js';

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkillAsync('mission-control', async () => {
    const contractPath = process.argv.find((arg) => arg.endsWith('.json'));
    if (!contractPath) {
      throw new Error('MissionContract JSON file path is required');
    }
    const approved = process.argv.includes('--approved');
    return await orchestrate(contractPath, approved);
  });
}
