import * as fs from 'node:fs';
import * as path from 'node:path';
import { runSkill } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { validateFilePath } from '@agent/core/validators';
import { safeWriteFile } from '@agent/core/secure-io';
import { detectFormat, curateJson, curateText } from './lib.js';

const argv = createStandardYargs()
  .option('input', { alias: 'i', type: 'string', demandOption: true })
  .option('out', { alias: 'o', type: 'string' })
  .option('format', { alias: 'f', type: 'string', choices: ['json', 'csv', 'text'] }).argv;

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkill('dataset-curator', () => {
    const inputPath = validateFilePath(argv.input as string);
    const content = fs.readFileSync(inputPath, 'utf8');
    const format = (argv.format as 'json' | 'csv' | 'text') || detectFormat(inputPath, content);

    const curateResult = format === 'json' ? curateJson(content) : curateText(content);

    const result = {
      inputFile: inputPath,
      format,
      originalRecords: curateResult.originalCount,
      cleanedRecords: curateResult.cleanedCount,
      removed: curateResult.removed,
      qualityReport: curateResult.qualityReport,
    };

    if (argv.out) {
      const outPath = path.resolve(argv.out as string);
      const outputContent =
        format === 'json'
          ? JSON.stringify(curateResult.records, null, 2)
          : curateResult.records.join('\n') + '\n';
      safeWriteFile(outPath, outputContent);
    }

    return result;
  });
}
