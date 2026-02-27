import fs from 'fs';
import path from 'path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { runAsyncSkill } from '@agent/core';
import { safeWriteFile } from '@agent/core/secure-io';
import { validateFilePath } from '@agent/core/validators';
import { generateHTML, ReportResult } from './lib.js';

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
    description: 'Output HTML file path',
  })
  .option('title', {
    alias: 't',
    type: 'string',
    default: 'Report',
    description: 'Report title',
  })
  .parseSync();

runAsyncSkill('html-reporter', async () => {
  const inputPath = validateFilePath(argv.input as string, 'input markdown');
  const outputPath = path.resolve(argv.out as string);

  const mdContent = fs.readFileSync(inputPath, 'utf8');
  const html = await generateHTML(mdContent, { title: argv.title as string });

  safeWriteFile(outputPath, html);

  const result: ReportResult = {
    output: outputPath,
    title: argv.title as string,
    size: html.length,
  };

  return result;
});
