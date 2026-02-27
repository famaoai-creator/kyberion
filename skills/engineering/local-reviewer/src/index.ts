import { runSkill } from '@agent/core';
import { getStagedDiff } from './lib.js';

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkill('local-reviewer', () => {
    return getStagedDiff();
  });
}
