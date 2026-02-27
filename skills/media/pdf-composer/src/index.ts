import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { runAsyncSkill } from '@agent/core';
import { validateFilePath } from '@agent/core/validators';
import { composePDF } from './lib.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const argv = yargs(hideBin(process.argv))
  .option('input', {
    alias: 'i',
    type: 'string',
    demandOption: true,
    description: 'Path to input Markdown file',
  })
  .option('out', {
    alias: 'o',
    type: 'string',
    demandOption: true,
    description: 'Output PDF file path',
  })
  .parseSync();

runAsyncSkill('pdf-composer', async () => {
  const inputPath = validateFilePath(argv.input as string, 'input markdown');
  const outputPath = path.resolve(argv.out as string);

  const mdContent = fs.readFileSync(inputPath, 'utf8');

  // Default theme path
  const themePath = path.resolve(__dirname, '../../../knowledge/templates/themes/standard.css');

  const result = await composePDF(mdContent, {
    outputPath,
    themePath: fs.existsSync(themePath) ? themePath : undefined,
  });

  return result;
});
