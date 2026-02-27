import fs from 'fs';
import path from 'path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { runSkill } from '@agent/core';
import { safeWriteFile } from '@agent/core/secure-io';
import { processUnitEconomics, CustomerSegment } from './lib.js';

const argv = yargs(hideBin(process.argv))
  .option('input', {
    alias: 'i',
    type: 'string',
    demandOption: true,
    description: 'Path to JSON file with unit economics data',
  })
  .option('out', {
    alias: 'o',
    type: 'string',
    description: 'Output file path',
  })
  .parseSync();

runSkill('unit-economics-optimizer', () => {
  const resolved = path.resolve(argv.input as string);
  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }

  const inputContent = fs.readFileSync(resolved, 'utf8');
  const data = JSON.parse(inputContent) as { segments: CustomerSegment[] };

  if (!data.segments || !Array.isArray(data.segments) || data.segments.length === 0) {
    throw new Error('Input must contain a "segments" array with at least one customer segment');
  }

  const result = processUnitEconomics(data.segments);
  const resultWithSource = {
    ...result,
    source: path.basename(resolved),
  };

  if (argv.out) {
    safeWriteFile(argv.out as string, JSON.stringify(resultWithSource, null, 2));
  }

  return resultWithSource;
});
