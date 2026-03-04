import * as fs from 'node:fs';
import * as path from 'node:path';
import { runAsyncSkill } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { safeWriteFile } from '@agent/core/secure-io';
import { parseInput, matchRunbook, autoHealTestFailure } from './lib.js';

const argv = createStandardYargs()
  .option('input', {
    alias: 'i',
    type: 'string',
    demandOption: true,
    description: 'Path to error log or JSON error report',
  })
  .option('auto-heal', {
    type: 'string',
    description: 'Path to source code to auto-heal based on the input test log'
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
  runAsyncSkill('self-healing-orchestrator', async () => {
    const resolved = path.resolve(argv.input as string);
    if (!fs.existsSync(resolved)) {
      throw new Error(`File not found: ${resolved}`);
    }

    if (argv['auto-heal']) {
      return autoHealTestFailure(resolved);
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
