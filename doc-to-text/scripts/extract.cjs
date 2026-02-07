const fs = require('fs');
const path = require('path');
const pdf = require('pdf-parse');
const xlsx = require('xlsx');
const mammoth = require('mammoth');
const Tesseract = require('tesseract.js');
const AdmZip = require('adm-zip');
const { logger, errorHandler } = require('../../scripts/lib/core.cjs');

const filePath = process.argv[2];

if (!filePath) {
    logger.error("Usage: node extract.cjs <file_path>");
    process.exit(1);
}

if (!fs.existsSync(filePath)) {
    errorHandler(new Error(`File not found: ${filePath}`));
}

async function extract() {
    const ext = path.extname(filePath).toLowerCase();
    
    try {
        logger.info(`Extracting content from: ${filePath}`);
        
        if (ext === '.pdf') {
            const dataBuffer = fs.readFileSync(filePath);
            const data = await pdf(dataBuffer);
            console.log(data.text);
        } else if (ext === '.xlsx' || ext === '.xls') {
            const workbook = xlsx.readFile(filePath);
            workbook.SheetNames.forEach(sheetName => {
                console.log(`--- Sheet: ${sheetName} ---`);
                const csv = xlsx.utils.sheet_to_csv(workbook.Sheets[sheetName]);
                console.log(csv);
            });
        } else if (ext === '.docx') {
            const data = await mammoth.extractRawText({ path: filePath });
            console.log(data.value);
        } else if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
            const result = await Tesseract.recognize(filePath, 'jpn+eng');
            console.log(result.data.text);
        } else {
            // Default to plain text
            console.log(fs.readFileSync(filePath, 'utf8'));
        }
        
        logger.success("Extraction completed.");
    } catch (err) {
        errorHandler(err, "Extraction Logic Error");
    }
}

extract();
