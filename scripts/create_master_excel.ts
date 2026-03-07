import ExcelJS from 'exceljs';
import * as fs from 'node:fs';

async function createMaster() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Kyberion-Standard');
  
  // Set some default styles to be distilled
  sheet.columns = [
    { header: 'ID', key: 'id', width: 10 },
    { header: 'Item', key: 'item', width: 30 },
    { header: 'Metrics', key: 'metrics', width: 30 },
    { header: 'Level', key: 'level', width: 10 },
    { header: 'Description', key: 'desc', width: 60 }
  ];

  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };

  await workbook.xlsx.writeFile('scratch/master_template.xlsx');
  console.log('Master template created at scratch/master_template.xlsx');
}

createMaster();
