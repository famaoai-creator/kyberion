import '@agent/core/secure-io'; // Enforce security boundaries
import fs from 'fs';
import path from 'path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { runAsyncSkill } from '@agent/core';
import { validateFilePath } from '@agent/core/validators';
import { distillExcelDesign, generateExcelWithDesign } from '@agent/core/excel-utils';
import { extractRowsFromHtml } from './lib.js';

const argv = yargs(hideBin(process.argv))
  .option('input', {
    alias: 'i',
    type: 'string',
    description: 'Path to input HTML or JSON file',
  })
  .option('out', {
    alias: 'o',
    type: 'string',
    demandOption: true,
    description: 'Output file path (.xlsx or .json for distill)',
  })
  .option('distill', {
    alias: 'd',
    type: 'string',
    description: 'Path to source Excel to extract Design Protocol (ADF)',
  })
  .option('template', {
    alias: 't',
    type: 'string',
    description: 'Path to Design Protocol (ADF) JSON to apply design',
  })
  .option('sheet', {
    type: 'string',
    default: '本番システム一覧',
    description: 'Sheet name to process',
  })
  .parseSync();

runAsyncSkill('excel-artisan', async () => {
  const outputPath = path.resolve(argv.out as string);

  // Mode: Distill (Extract Design)
  if (argv.distill) {
    const sourcePath = path.resolve(argv.distill as string);
    validateFilePath(sourcePath, 'source excel');
    console.log(`[ExcelArtisan] Distilling design from: ${sourcePath}`);
    const protocol = await distillExcelDesign(sourcePath);
    fs.writeFileSync(outputPath, JSON.stringify(protocol, null, 2));
    console.log(`[ExcelArtisan] Design Protocol (ADF) saved to: ${outputPath}`);
    return { output: outputPath };
  }

  // Mode: Generate with Template
  if (argv.input && argv.template) {
    const inputPath = path.resolve(argv.input as string);
    const templatePath = path.resolve(argv.template as string);
    validateFilePath(inputPath, 'input file');
    validateFilePath(templatePath, 'template file');

    console.log(`[ExcelArtisan] Generating Excel using template: ${templatePath}`);
    const protocol = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
    
    let rows: any[][] = [];
    const ext = path.extname(inputPath).toLowerCase();
    
    if (ext === '.html' || ext === '.htm') {
      rows = extractRowsFromHtml(fs.readFileSync(inputPath, 'utf8'));
    } else {
      rows = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
    }

    const workbook = await generateExcelWithDesign(rows, protocol, argv.sheet);
    await workbook.xlsx.writeFile(outputPath);
    console.log(`[ExcelArtisan] Replicated Excel created at: ${outputPath}`);
    return { input: inputPath, output: outputPath };
  }

  console.error('[ExcelArtisan] Invalid usage. Provide either --distill or (--input and --template).');
  process.exit(1);
});
