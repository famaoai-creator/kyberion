import * as fs from 'fs';
import * as path from 'path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { runSkill } from '@agent/core';
import { validateFilePath } from '@agent/core/validators';
import { calculateScore, ScoringRules, DEFAULT_RULES } from './lib.js';

const argv = yargs(hideBin(process.argv))
  .option('input', {
    alias: 'i',
    type: 'string',
    demandOption: true,
    description: 'Path to content to score',
  })
  .help()
  .parseSync();

runSkill('quality-scorer', () => {
  const inputPath = validateFilePath(argv.input as string);
  const content = fs.readFileSync(inputPath, 'utf8');

  // 1. Load Knowledge
  let scoring_rules: ScoringRules = DEFAULT_RULES;
  const result = calculateScore(content, scoring_rules);

  return {
    status: 'scored',
    score: result.score,
    metrics: result.metrics,
    compliance: 'SCAP-Layer-2',
    issues: result.issues,
  };
});
