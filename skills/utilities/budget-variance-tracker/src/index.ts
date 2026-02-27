import * as fs from 'node:fs';
import * as path from 'node:path';
import { runSkill } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { safeWriteFile } from '@agent/core/secure-io';
import { analyzeVariance, CategoryAnalysis } from './lib.js';

const argv = createStandardYargs()
  .option('input', { alias: 'i', type: 'string', demandOption: true })
  .option('threshold', { alias: 't', type: 'number', default: 10 })
  .option('out', { alias: 'o', type: 'string' })
  .parseSync();

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkill('budget-variance-tracker', () => {
    const data = JSON.parse(fs.readFileSync(path.resolve(argv.input as string), 'utf8'));
    const analyses: CategoryAnalysis[] = data.categories.map((c: any) =>
      analyzeVariance(c, argv.threshold as number)
    );

    const result = {
      period: data.period || 'unspecified',
      summary: {
        totalForecast: analyses.reduce((s: number, a: CategoryAnalysis) => s + a.forecast, 0),
        totalActual: analyses.reduce((s: number, a: CategoryAnalysis) => s + a.actual, 0),
      },
      categories: analyses,
    };

    if (argv.out) safeWriteFile(argv.out as string, JSON.stringify(result, null, 2));
    return result;
  });
}
