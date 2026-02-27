import * as fs from 'node:fs';
import * as path from 'node:path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { runSkill } from '@agent/core';
import { safeWriteFile } from '@agent/core/secure-io';
import { calculateReadinessScore, generateI18nAudit } from './lib.js';

const argv = yargs(hideBin(process.argv))
  .option('input', {
    alias: 'i',
    type: 'string',
    default: '.',
    description: 'Project directory to audit for localization',
  })
  .option('out', {
    alias: 'o',
    type: 'string',
    description: 'Output path for localization audit report',
  })
  .help()
  .parseSync();

runSkill('localization-maestro', () => {
  const targetDir = path.resolve(argv.input as string);
  if (!fs.existsSync(targetDir)) throw new Error('Directory not found: ' + targetDir);

  const mockFindings = { i18nReady: false };
  const audit = generateI18nAudit(mockFindings);

  const result = {
    directory: targetDir,
    i18nReadiness: { score: calculateReadinessScore(mockFindings) },
    audit,
  };

  if (argv.out) {
    safeWriteFile(argv.out as string, JSON.stringify(result, null, 2));
  }

  return result;
});
