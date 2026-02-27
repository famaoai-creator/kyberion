import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import ExcelJS from 'exceljs';
import { runAsyncSkill } from '@agent/core';
import { validateFilePath } from '@agent/core/validators';
import {
  createWorkbookFromHTML,
  applySpecsToWorkbook,
  ExcelSheetDef,
  ExcelMasterSpecs,
} from './lib.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const argv = yargs(hideBin(process.argv))
  .option('input', {
    alias: 'i',
    type: 'string',
    demandOption: true,
    description: 'Path to input HTML or JSON file',
  })
  .option('out', {
    alias: 'o',
    type: 'string',
    demandOption: true,
    description: 'Output file path (.xlsx)',
  })
  .parseSync();

runAsyncSkill('excel-artisan', async () => {
  const inputPath = path.resolve(argv.input as string);
  const outputPath = path.resolve(argv.out as string);
  validateFilePath(inputPath, 'input file');

  const ext = path.extname(inputPath).toLowerCase();
  let workbook: ExcelJS.Workbook;

  if (ext === '.html' || ext === '.htm') {
    const htmlContent = fs.readFileSync(inputPath, 'utf8');
    workbook = await createWorkbookFromHTML(htmlContent);
  } else {
    // Assume JSON (ADF)
    const adf = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
    const sheets = adf.sheets as ExcelSheetDef[];

    const specsPath = path.resolve(
      __dirname,
      '../../../knowledge/standards/design/excel-master-specs.json'
    );
    if (!fs.existsSync(specsPath)) {
      throw new Error(`Excel master specs missing: ${specsPath}`);
    }
    const specs = JSON.parse(fs.readFileSync(specsPath, 'utf8')) as ExcelMasterSpecs;

    workbook = new ExcelJS.Workbook();
    applySpecsToWorkbook(workbook, sheets, specs);
  }

  await workbook.xlsx.writeFile(outputPath);

  return { input: inputPath, output: outputPath };
});
