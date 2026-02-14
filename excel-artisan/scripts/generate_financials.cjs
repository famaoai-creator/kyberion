#!/usr/bin/env node
/**
 * excel-artisan/scripts/generate_financials.cjs
 * Unified Data-Driven Financial Renderer
 */

const { runSkillAsync } = require('@agent/core');
const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');
const { requireArgs } = require('@agent/core/validators');

runSkillAsync('excel-artisan', async () => {
  const argv = requireArgs(['input', 'out']);
  const inputPath = path.resolve(argv.input);
  const outputPath = path.resolve(argv.out);

  // 1. Load Source of Truth (Text)
  const adf = JSON.parse(fs.readFileSync(inputPath, 'utf8'));

  // 2. Load Formal Master Specs
  const specsPath = path.resolve(
    __dirname,
    '../../knowledge/standards/design/excel-master-specs.json'
  );
  const specs = JSON.parse(fs.readFileSync(specsPath, 'utf8'));

  const workbook = new ExcelJS.Workbook();

  adf.sheets.forEach((sheetDef) => {
    const sheet = workbook.addWorksheet(sheetDef.name);
    if (specs.layout.hide_gridlines) sheet.views = [{ showGridLines: false }];

    sheet.addRows(sheetDef.rows);

    // Apply Styles from Master Specs
    const headerRow = sheet.getRow(1);
    headerRow.eachCell((cell) => {
      Object.assign(cell, specs.styles.header);
    });

    // Apply column widths
    sheet.columns = sheetDef.rows[0].map(() => ({ width: specs.layout.default_column_width }));

    // Dynamic formatting for numbers
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber > 1) {
        row.eachCell((cell, colNumber) => {
          if (typeof cell.value === 'number') {
            cell.numFmt = specs.styles.currency_cell.numFmt;
          }
        });
      }
    });
  });

  await workbook.xlsx.writeFile(outputPath);
  console.log(`[Excel] Rendered with Master '${specs.master_name}' to ${argv.out}`);

  return { status: 'success', output: outputPath, master: specs.master_name };
});
