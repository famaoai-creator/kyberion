import * as fs from 'node:fs';
import * as path from 'node:path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { runSkill } from '@agent/core';
import { safeWriteFile } from '@agent/core/secure-io';
import { assessInfraEnergy } from './lib.js';

const argv = yargs(hideBin(process.argv))
  .option('input', {
    alias: 'i',
    type: 'string',
    default: '.',
    description: 'Directory to assess for sustainability',
  })
  .option('out', {
    alias: 'o',
    type: 'string',
    description: 'Output path for sustainability report',
  })
  .help()
  .parseSync();

runSkill('sustainability-consultant', () => {
  const targetDir = path.resolve(argv.input as string);
  if (!fs.existsSync(targetDir)) throw new Error('Directory not found: ' + targetDir);

  const energy = assessInfraEnergy(targetDir);
  const result = {
    directory: targetDir,
    carbonFootprint: energy,
    greenScore: Math.max(0, 100 - energy.totalKwh / 5),
  };

  if (argv.out) {
    safeWriteFile(argv.out as string, JSON.stringify(result, null, 2));
  }

  return result;
});
