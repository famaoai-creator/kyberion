const fs = require('fs');
const path = require('path');
const pdf = require('pdf-parse');
const ExcelJS = require('exceljs');
const mammoth = require('mammoth');
const Tesseract = require('tesseract.js');
const { logger } = require('../../scripts/lib/core.cjs');
const { runAsyncSkill } = require('../../scripts/lib/skill-wrapper.cjs');

const filePath = process.argv[2];

if (!filePath) {
    logger.error("Usage: node extract.cjs <file_path>");
    process.exit(1);
}

if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
}

runAsyncSkill('doc-to-text', async () => {
    const ext = path.extname(filePath).toLowerCase();
    logger.info(`Extracting content from: ${filePath}`);

    let text = '';

    if (ext === '.pdf') {
        const dataBuffer = fs.readFileSync(filePath);
        const data = await pdf(dataBuffer);
        text = data.text;
    } else if (ext === '.xlsx' || ext === '.xls') {
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(filePath);
        const parts = [];
        workbook.eachSheet((worksheet, _sheetId) => {
            parts.push(`--- Sheet: ${worksheet.name} ---`);
            worksheet.eachRow((row, _rowNumber) => {
                // Join cell values with comma to simulate CSV
                const rowValues = row.values;
                // row.values is 1-based array, so index 0 is undefined. filter it out.
                const line = Array.isArray(rowValues) ? rowValues.slice(1).join(',') : '';
                parts.push(line);
            });
        });
        text = parts.join('\n');
    } else if (ext === '.docx') {
        const data = await mammoth.extractRawText({ path: filePath });
        text = data.value;
    } else if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
        const result = await Tesseract.recognize(filePath, 'jpn+eng');
        text = result.data.text;
    } else {
        // Default to plain text
        text = fs.readFileSync(filePath, 'utf8');
    }

    logger.success("Extraction completed.");
    return { filePath, format: ext, contentLength: text.length, content: text };
});