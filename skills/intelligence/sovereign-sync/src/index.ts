import '@agent/core/secure-io'; // Enforce security boundaries
import * as path from 'node:path';
import { runSkill } from '@agent/core';
import { requireArgs } from '@agent/core/validators';
import { syncTier } from './lib.js';

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkill('sovereign-sync', () => {
    const args = requireArgs(['tier', 'repo']);
    const baseDir = path.resolve(__dirname, '../../../knowledge');
    return syncTier(args.tier.toLowerCase(), args.repo, baseDir);
  });
}
