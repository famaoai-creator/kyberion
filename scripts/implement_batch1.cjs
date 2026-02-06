const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const rootDir = process.cwd();

// Helper to write file safely
function write(filePath, content) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
    console.log(`Updated: ${path.relative(rootDir, filePath)}`);
}

// Helper to install deps
function installDeps(skillName, packages) {
    const skillDir = path.join(rootDir, skillName);
    console.log(`Installing deps for ${skillName}: ${packages}`);
    try {
        execSync(`npm install ${packages}`, { cwd: skillDir, stdio: 'inherit' });
    } catch (e) {
        console.error(`Failed to install deps for ${skillName}`);
    }
}

// --- 1. data-transformer ---
const dtDir = 'data-transformer';
installDeps(dtDir, 'js-yaml papaparse yargs');
write(path.join(rootDir, dtDir, 'scripts/transform.cjs'), `
const fs = require('fs');
const yaml = require('js-yaml');
const Papa = require('papaparse');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const argv = yargs(hideBin(process.argv))
    .option('input', { alias: 'i', type: 'string', demandOption: true })
    .option('to', { alias: 't', type: 'string', choices: ['json', 'yaml', 'csv'], demandOption: true })
    .option('out', { alias: 'o', type: 'string' })
    .argv;

try {
    const content = fs.readFileSync(argv.input, 'utf8');
    let data;

    // Auto-detect input format
    if (argv.input.endsWith('.json')) data = JSON.parse(content);
    else if (argv.input.endsWith('.yaml') || argv.input.endsWith('.yml')) data = yaml.load(content);
    else if (argv.input.endsWith('.csv')) data = Papa.parse(content, { header: true, dynamicTyping: true }).data;
    else throw new Error("Unknown input format. Use .json, .yaml, or .csv");

    let output = '';
    switch (argv.to) {
        case 'json': output = JSON.stringify(data, null, 2); break;
        case 'yaml': output = yaml.dump(data); break;
        case 'csv': output = Papa.unparse(data); break;
    }

    if (argv.out) {
        fs.writeFileSync(argv.out, output);
        console.log(`Converted to ${argv.to}: ${argv.out}`);
    } else {
        console.log(output);
    }
} catch (e) {
    console.error("Error:", e.message);
    process.exit(1);
}
`);

// --- 2. template-renderer ---
const trDir = 'template-renderer';
installDeps(trDir, 'mustache yargs');
write(path.join(rootDir, trDir, 'scripts/render.cjs'), `
const fs = require('fs');
const Mustache = require('mustache');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const argv = yargs(hideBin(process.argv))
    .option('template', { alias: 't', type: 'string', demandOption: true })
    .option('data', { alias: 'd', type: 'string', demandOption: true })
    .option('out', { alias: 'o', type: 'string' })
    .argv;

try {
    const template = fs.readFileSync(argv.template, 'utf8');
    const dataContent = fs.readFileSync(argv.data, 'utf8');
    const data = JSON.parse(dataContent);

    const output = Mustache.render(template, data);

    if (argv.out) {
        fs.writeFileSync(argv.out, output);
        console.log(`Rendered to: ${argv.out}`);
    } else {
        console.log(output);
    }
} catch (e) {
    console.error("Error:", e.message);
    process.exit(1);
}
`);

// --- 3. word-artisan ---
// Using HTML as intermediate: Markdown -> HTML -> Docx
const waDir = 'word-artisan';
installDeps(waDir, 'marked html-to-docx yargs jsdom');
write(path.join(rootDir, waDir, 'scripts/convert.cjs'), `
const fs = require('fs');
const { marked } = require('marked');
const HTMLtoDOCX = require('html-to-docx');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const argv = yargs(hideBin(process.argv))
    .option('input', { alias: 'i', type: 'string', demandOption: true })
    .option('out', { alias: 'o', type: 'string', demandOption: true })
    .argv;

(async () => {
    try {
        const md = fs.readFileSync(argv.input, 'utf8');
        const htmlContent = marked.parse(md);
        
        const fullHtml = 
        <html><head></head><body>${htmlContent}</body></html>

        const fileBuffer = await HTMLtoDOCX(fullHtml, null, {
            table: { row: { cantSplit: true } },
            footer: true,
            pageNumber: true,
        });

        fs.writeFileSync(argv.out, fileBuffer);
        console.log(`Generated Word Doc: ${argv.out}`);
    } catch (e) {
        console.error("Error:", e.message);
        process.exit(1);
    }
})();
`);

// --- 4. pdf-composer ---
const pcDir = 'pdf-composer';
installDeps(pcDir, 'markdown-pdf yargs');
write(path.join(rootDir, pcDir, 'scripts/compose.cjs'), `
const fs = require('fs');
const markdownpdf = require('markdown-pdf');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const argv = yargs(hideBin(process.argv))
    .option('input', { alias: 'i', type: 'string', demandOption: true })
    .option('out', { alias: 'o', type: 'string', demandOption: true })
    .argv;

try {
    markdownpdf()
        .from(argv.input)
        .to(argv.out, function () {
            console.log(`Generated PDF: ${argv.out}`);
        });
} catch (e) {
    console.error("Error:", e.message);
    process.exit(1);
}
`);

// --- 5. html-reporter ---
const hrDir = 'html-reporter';
installDeps(hrDir, 'marked yargs');
write(path.join(rootDir, hrDir, 'scripts/report.cjs'), `
const fs = require('fs');
const { marked } = require('marked');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const argv = yargs(hideBin(process.argv))
    .option('input', { alias: 'i', type: 'string', demandOption: true })
    .option('title', { alias: 't', type: 'string', default: 'Report' })
    .option('out', { alias: 'o', type: 'string', demandOption: true })
    .argv;

try {
    const md = fs.readFileSync(argv.input, 'utf8');
    const body = marked.parse(md);

    const html = 
    
<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <title>${argv.title}</title>
    <style>
        body { font-family: sans-serif; max-width: 800px; margin: 0 auto; padding: 2rem; line-height: 1.6; }
        h1, h2, h3 { color: #333; }
        code { background: #f4f4f4; padding: 0.2rem 0.4rem; border-radius: 4px; }
        pre { background: #f4f4f4; padding: 1rem; overflow-x: auto; }
        table { border-collapse: collapse; width: 100%; margin-bottom: 1rem; }
        th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
        th { background-color: #f2f2f2; }
    </style>
</head>
<body>
    ${body}
</body>
</html>

    fs.writeFileSync(argv.out, html);
    console.log(`Generated HTML Report: ${argv.out}`);
} catch (e) {
    console.error("Error:", e.message);
    process.exit(1);
}
`);

console.log("\nBatch 1 Implementation Complete.");
