const fs = require('fs');
const ExcelJS = require('exceljs');
const chalk = require('chalk');
const jsdom = require('jsdom');
const { JSDOM } = jsdom;
const { runAsyncSkill } = require('@agent/core');
const { validateFilePath } = require('@agent/core/validators');

const inputFile = process.argv[2];
const outputFile = process.argv[3];

if (!inputFile || !outputFile) {
  console.error(chalk.red('Usage: node html_to_excel.cjs <input.html> <output.xlsx>'));
  process.exit(1);
}

validateFilePath(inputFile, 'input HTML');

runAsyncSkill('excel-artisan', async () => {
  const htmlContent = fs.readFileSync(inputFile, 'utf8');

  // Parse HTML using jsdom
  const dom = new JSDOM(htmlContent);
  const document = dom.window.document;
  const table = document.querySelector('table');

  if (!table) {
    throw new Error('No <table> tag found in the HTML file.');
  }

  // Extract rows from HTML table
  const rows = [];
  const trElements = table.querySelectorAll('tr');
  for (const tr of trElements) {
    const cells = [];
    const tdElements = tr.querySelectorAll('th, td');
    for (const td of tdElements) {
      cells.push(td.textContent.trim());
    }
    rows.push(cells);
  }

  // Build Excel workbook using ExcelJS
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Sheet1');
  for (const row of rows) {
    worksheet.addRow(row);
  }

  await workbook.xlsx.writeFile(outputFile);

  return { input: inputFile, output: outputFile, rows: rows.length };
});
