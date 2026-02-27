import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { runAsyncSkill } from '@agent/core';
import { safeWriteFile } from '@agent/core/secure-io';
import { validateFilePath } from '@agent/core/validators';
import { generateWordContent, WordMasterSpecs } from './lib.js';

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
    description: 'Output Word file path (.docx)',
  })
  .parseSync();

runAsyncSkill('word-artisan', async () => {
  const inputPath = validateFilePath(argv.input as string, 'input file');
  const outputPath = path.resolve(argv.out as string);

  // 1. Load Master Specs
  const specsPath = path.resolve(
    __dirname,
    '../../../knowledge/standards/design/word-master-specs.json'
  );
  if (!fs.existsSync(specsPath)) {
    throw new Error(`Word master specs missing at: ${specsPath}`);
  }
  const specs = JSON.parse(fs.readFileSync(specsPath, 'utf8')) as WordMasterSpecs;

  // 2. Process Content
  const md = fs.readFileSync(inputPath, 'utf8');
  const fileBuffer = await generateWordContent(md, specs);

  // 3. Save File
  safeWriteFile(outputPath, fileBuffer);

  return { status: 'success', output: outputPath, master: specs.master_name };
});
