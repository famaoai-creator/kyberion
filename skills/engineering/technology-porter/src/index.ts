import * as fs from 'fs';
import * as path from 'path';
import { runSkill } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { safeWriteFile } from '@agent/core/secure-io';
import { detectLanguage, analyzeSource, estimateMigration } from './lib.js';

const argv = createStandardYargs()
  .option('input', {
    alias: 'i',
    type: 'string',
    demandOption: true,
    description: 'Source file to analyze for porting',
  })
  .option('from', { type: 'string', description: 'Source language (auto-detected if omitted)' })
  .option('to', {
    alias: 't',
    type: 'string',
    demandOption: true,
    choices: ['javascript', 'typescript', 'python', 'go', 'rust'],
    description: 'Target language',
  })
  .option('out', { alias: 'o', type: 'string', description: 'Output file path' })
  .help().parseSync();

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkill('technology-porter', () => {
    const resolved = path.resolve(argv.input as string);
    if (!fs.existsSync(resolved)) throw new Error(`File not found: ${resolved}`);

    const content = safeReadFile(resolved, 'utf8');
    const fromLang = (argv.from as string) || detectLanguage(resolved);
    const toLang = argv.to as string;

    const analysis = analyzeSource(content, fromLang);
    const migration = estimateMigration(analysis, fromLang, toLang);

    const result = {
      source: path.basename(resolved),
      fromLanguage: fromLang,
      toLanguage: toLang,
      sourceAnalysis: analysis,
      migrationPlan: migration,
      recommendations: [
        `Source: ${fromLang} (${analysis.lines} lines, ${analysis.functions} functions)`,
        `Target: ${toLang} - ${migration.estimatedEffort} effort`,
        ...migration.manualReviewRequired.slice(0, 2).map((r) => `[manual] ${r}`),
      ],
    };

    if (argv.out) safeWriteFile(argv.out as string, JSON.stringify(result, null, 2));

    return result;
  });
}
