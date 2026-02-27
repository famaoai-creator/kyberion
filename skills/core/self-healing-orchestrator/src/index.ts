import * as fs from 'node:fs';
import * as path from 'node:path';
import { runSkill } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { safeWriteFile } from '@agent/core/secure-io';
import { parseInput, matchRunbook } from './lib.js';

const argv = createStandardYargs()
  .option('input', {
    alias: 'i',
    type: 'string',
    demandOption: true,
    description: 'Path to error log or JSON error report',
  })
  .option('dry-run', {
    type: 'boolean',
    default: true,
    description: 'Only propose fixes without applying them',
  })
  .option('out', {
    alias: 'o',
    type: 'string',
    description: 'Output file path',
  })
  .help()
  .parseSync();

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkill('self-healing-orchestrator', () => {
    const resolved = path.resolve(argv.input as string);
    if (!fs.existsSync(resolved)) {
      throw new Error(`File not found: ${resolved}`);
    }

    const errors = parseInput(resolved);
    const healingPlan = matchRunbook(errors);

    const result = {
      source: path.basename(resolved),
      mode: argv['dry-run'] ? 'dry-run' : 'apply',
      errorsAnalyzed: errors.length,
      matchedRules: healingPlan.length,
      healingPlan,
      unmatchedErrors: errors.length - healingPlan.length,
      summary:
        healingPlan.length > 0
          ? `Found ${healingPlan.length} actionable patterns. Top issue: ${healingPlan[0].diagnosis}`
          : 'No known error patterns matched. Manual investigation recommended.',
    };

    if (argv.out) {
      safeWriteFile(argv.out as string, JSON.stringify(result, null, 2));
    }

    return result;
  });
}
