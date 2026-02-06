const fs = require('fs');
const path = require('path');
const pdf = require('pdf-parse');
const xlsx = require('xlsx');
const mammoth = require('mammoth');
const Tesseract = require('tesseract.js');
const AdmZip = require('adm-zip');
const simpleParser = require('mailparser').simpleParser;
const officeParser = require('officeparser');

const filePath = process.argv[2];

if (!filePath) {
    console.error("Usage: node extract.cjs <file_path>");
    process.exit(1);
}

if (!fs.existsSync(filePath)) {
    console.error(`Error: File not found at ${filePath}`);
    process.exit(1);
}

const ext = path.extname(filePath).toLowerCase();

async function extractText() {
    try {
        switch (ext) {
            case '.pdf': await processPdf(filePath); break;
            case '.xlsx':
            case '.xls':
            case '.csv': await processExcel(filePath); break; // Changed to async
            case '.docx': await processWord(filePath); break;
            case '.pptx': await processPptx(filePath); break;
            case '.png':
            case '.jpg':
            case '.jpeg':
            case '.bmp':
            case '.webp': await processImage(filePath); break;
            case '.eml': await processEmail(filePath); break;
            case '.zip': processZip(filePath); break;
            case '.txt':
            case '.md':
            case '.json':
            case '.js':
            case '.ts':
            case '.py':
            case '.html':
            case '.css':
            case '.xml':
            case '.yaml':
            case '.yml':
                console.log(fs.readFileSync(filePath, 'utf8'));
                break;
            default:
                console.error(`Unsupported file extension: ${ext}`);
                process.exit(1);
        }
    } catch (error) {
        console.error(`Error processing file: ${error.message}`);
        process.exit(1);
    }
}

// --- Shared Helpers ---

async function extractAndOcrImages(file, mediaPathPrefix) {
    try {
        const zip = new AdmZip(file);
        const zipEntries = zip.getEntries();
        // Look for images in the specified media folder (e.g., 'ppt/media/', 'xl/media/')
        const mediaEntries = zipEntries.filter(entry => 
            entry.entryName.startsWith(mediaPathPrefix) && 
            /\.(png|jpg|jpeg|bmp|webp)$/i.test(entry.entryName)
        );

        if (mediaEntries.length > 0) {
            console.log(`\n[Embedded Images (${mediaEntries.length} found in ${mediaPathPrefix})]`);
            console.log("Running OCR... (This may take a moment)");

            const worker = await Tesseract.createWorker('eng+jpn', 1, {
                logger: m => {} 
            });

            for (const entry of mediaEntries) {
                const buffer = entry.getData();
                console.log(`\n> Processing image: ${path.basename(entry.entryName)}`);
                const { data: { text } } = await worker.recognize(buffer);
                const trimmed = text.trim();
                if (trimmed) {
                    console.log(trimmed);
                } else {
                    console.log("(No text detected)");
                }
            }
            await worker.terminate();
        } else {
            console.log(`\n[No Embedded Images Found in ${mediaPathPrefix}]`);
        }
    } catch (e) {
        // Zip extraction might fail if the file is strictly binary (like legacy .xls), ignore silently or warn
        // console.warn("(Image extraction skipped: ${e.message})"); 
    }
}

// --- Processors ---

async function processPdf(file) {
    const dataBuffer = fs.readFileSync(file);
    const data = await pdf(dataBuffer);
    console.log("--- PDF CONTENT START ---");
    console.log(data.text);
    console.log("--- PDF CONTENT END ---");
}

async function processExcel(file) {
    console.log("--- EXCEL CONTENT START ---");
    
    // 1. Text Data
    console.log("[Text Layer]");
    const workbook = xlsx.readFile(file);
    workbook.SheetNames.forEach(sheetName => {
        console.log(`\n## Sheet: ${sheetName}`);
        const worksheet = workbook.Sheets[sheetName];
        const csv = xlsx.utils.sheet_to_csv(worksheet);
        console.log(csv);
    });

    // 2. Images (OCR) - only for .xlsx (zip based)
    if (path.extname(file).toLowerCase() === '.xlsx') {
        await extractAndOcrImages(file, 'xl/media/');
    }

    console.log("--- EXCEL CONTENT END ---");
}

async function processWord(file) {
    console.log("--- WORD CONTENT START ---");

    // 1. Text Data
    console.log("[Text Layer]");
    const result = await mammoth.extractRawText({ path: file });
    console.log(result.value);

    // 2. Images (OCR)
    await extractAndOcrImages(file, 'word/media/');

    console.log("--- WORD CONTENT END ---");
}

async function processPptx(file) {
    console.log("--- POWERPOINT CONTENT START ---");
    
    // 1. Text Data
    try {
        await new Promise((resolve, reject) => {
            officeParser.parseOffice(file, (data, err) => {
                if (err) {
                    console.warn("Warning: Text extraction failed:", err);
                    resolve(); 
                } else {
                    console.log("\n[Text Layer]");
                    console.log(data);
                    resolve();
                }
            });
        });
    } catch (e) {
        console.warn("Text extraction skipped due to error.");
    }

    // 2. Images (OCR)
    await extractAndOcrImages(file, 'ppt/media/');

    console.log("--- POWERPOINT CONTENT END ---");
}

async function processImage(file) {
    console.log("--- OCR START (Processing Image...) ---");
    const { data: { text } } = await Tesseract.recognize(file, 'eng+jpn', {
        logger: m => {} 
    });
    console.log(text);
    console.log("--- OCR END ---");
}

async function processEmail(file) {
    const source = fs.readFileSync(file);
    const parsed = await simpleParser(source);
    console.log("--- EMAIL CONTENT START ---");
    console.log(`Subject: ${parsed.subject}`);
    console.log(`From: ${parsed.from ? parsed.from.text : 'Unknown'}`);
    console.log(`To: ${parsed.to ? parsed.to.text : 'Unknown'}`);
    console.log(`Date: ${parsed.date}`);
    console.log("\nBody:");
    console.log(parsed.text || parsed.html); 
    console.log("--- EMAIL CONTENT END ---");
}

function processZip(file) {
    console.log("--- ZIP ARCHIVE CONTENT START ---");
    const zip = new AdmZip(file);
    const zipEntries = zip.getEntries();

    zipEntries.forEach(zipEntry => {
        if (zipEntry.isDirectory) return;
        const entryName = zipEntry.entryName;
        if (/\.(txt|md|json|js|ts|py|html|css|xml|yaml|yml|csv|log)$/i.test(entryName)) {
            console.log(`\n### File: ${entryName}`);
            console.log(zipEntry.getData().toString('utf8'));
        } else {
            console.log(`\n### File: ${entryName} (Skipped binary/unsupported)`);
        }
    });
    console.log("--- ZIP ARCHIVE CONTENT END ---");
}

extractText();
