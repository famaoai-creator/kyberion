import * as fs from 'node:fs';
import * as path from 'node:path';
import { runSkill } from '@agent/core';
import { requireArgs } from '@agent/core/validators';
import { safeWriteFile } from '@agent/core/secure-io';
import { generateTestCases } from './lib.js';

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkill('test-viewpoint-analyst', () => {
    const argv = requireArgs(['input', 'out']);
    const reqAdf = JSON.parse(safeReadFile(path.resolve(argv.input as string), 'utf8'));

    const testCases = generateTestCases(reqAdf);

    const testAdf = {
      project: reqAdf.project,
      test_cases: testCases,
    };

    safeWriteFile(path.resolve(argv.out as string), JSON.stringify(testAdf, null, 2));

    return { status: 'success', testCaseCount: testCases.length, output: argv.out };
  });
}
