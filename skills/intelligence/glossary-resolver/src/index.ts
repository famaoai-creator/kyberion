import { runSkill } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { validateFilePath, readJsonFile } from '@agent/core/validators';
import { resolveGlossaryFile, Glossary } from './lib.js';

const argv = createStandardYargs()
  .option('input', { alias: 'i', type: 'string', demandOption: true })
  .option('glossary', { alias: 'g', type: 'string', demandOption: true })
  .option('out', { alias: 'o', type: 'string' })
  .parseSync();

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkill('glossary-resolver', () => {
    const inputPath = validateFilePath(argv.input as string, 'input');
    const glossary = readJsonFile(argv.glossary as string, 'glossary') as Glossary;
    const outPath = argv.out as string | undefined;

    return resolveGlossaryFile(inputPath, glossary, outPath);
  });
}
