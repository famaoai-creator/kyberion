import '@agent/core/secure-io'; // Enforce security boundaries
import * as path from 'node:path';
import { runSkill } from '@agent/core';
import { requireArgs } from '@agent/core/validators';
import { syncTier } from './lib.js';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkill('sovereign-sync', () => {
    const argv = yargs(hideBin(process.argv)).parseSync();
    requireArgs(argv, ['tier', 'repo']);
    const args = argv as any;
    const baseDir = path.resolve(__dirname, '../../../knowledge');
    return syncTier(args.tier.toLowerCase(), args.repo, baseDir);
  });
}
