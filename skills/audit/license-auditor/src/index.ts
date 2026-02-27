import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { runSkill } from '@agent/core';
import { safeWriteFile } from '@agent/core/secure-io';
import { scanDepsForRiskyLicenses } from './lib.js';

const argv = yargs(hideBin(process.argv))
  .option('input', {
    alias: 'i',
    type: 'string',
    default: '.',
    description: 'Project root directory to audit licenses',
  })
  .option('out', {
    alias: 'o',
    type: 'string',
    description: 'Output path for license report',
  })
  .help()
  .parseSync();

runSkill('license-auditor', () => {
  const rootDir = path.resolve(argv.input as string);
  let npmList: any;
  try {
    npmList = JSON.parse(execSync('npm list --all --json', { cwd: rootDir, encoding: 'utf8' }));
  } catch {
    npmList = JSON.parse(execSync('npm list --depth=0 --json', { cwd: rootDir, encoding: 'utf8' }));
  }

  const findings = scanDepsForRiskyLicenses(npmList.dependencies);
  const result = { status: findings.length > 0 ? 'warning' : 'compliant', findings };

  if (argv.out) {
    safeWriteFile(argv.out as string, JSON.stringify(result, null, 2));
  }

  return result;
});
