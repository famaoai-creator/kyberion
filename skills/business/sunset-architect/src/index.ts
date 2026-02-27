import fs from 'fs';
import path from 'path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { runSkill } from '@agent/core';
import { safeWriteFile } from '@agent/core/secure-io';
import { processSunsetPlans, FeatureData } from './lib.js';

const argv = yargs(hideBin(process.argv))
  .option('input', {
    alias: 'i',
    type: 'string',
    demandOption: true,
    description: 'Path to JSON with feature/service data to sunset',
  })
  .option('out', {
    alias: 'o',
    type: 'string',
    description: 'Output file path',
  })
  .parseSync();

runSkill('sunset-architect', () => {
  const resolved = path.resolve(argv.input as string);
  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }

  const inputContent = fs.readFileSync(resolved, 'utf8');
  const data = JSON.parse(inputContent);

  // Handle both single feature and array of features
  const features: FeatureData[] = Array.isArray(data.features)
    ? data.features
    : Array.isArray(data)
      ? data
      : [data as FeatureData];

  const result = processSunsetPlans(features);
  const resultWithSource = {
    ...result,
    source: path.basename(resolved),
  };

  if (argv.out) {
    safeWriteFile(argv.out as string, JSON.stringify(resultWithSource, null, 2));
  }

  return resultWithSource;
});
