import * as fs from 'node:fs';
import * as path from 'node:path';
import { runSkill, safeReadFile, safeWriteFile } from '@agent/core';
import { requireArgs } from '@agent/core/validators';
import { generateTestCases } from './lib.js';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkill('test-viewpoint-analyst', () => {
    const argv = yargs(hideBin(process.argv)).parseSync() as any;
    requireArgs(argv, ['input', 'out']);
    const reqAdf = JSON.parse(safeReadFile(path.resolve(argv.input as string), { encoding: 'utf8' }) as string);

    const testCases = generateTestCases(reqAdf);

    const testAdf = {
      project: reqAdf.project,
      test_cases: testCases,
    };

    safeWriteFile(path.resolve(argv.out as string), JSON.stringify(testAdf, null, 2));

    return { status: 'success', testCaseCount: testCases.length, output: argv.out };
  });
}
