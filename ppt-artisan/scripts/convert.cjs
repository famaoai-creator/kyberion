const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { logger, errorHandler } = require('../../scripts/lib/core.cjs');

const inputFilePath = process.argv[2];
const outputFormat = process.argv[3] || 'pptx';
const customTheme = process.argv.includes('--theme') ? process.argv[process.argv.indexOf('--theme') + 1] : null;
const isEditable = process.argv.includes('--editable-pptx');

if (!inputFilePath) {
  logger.error('Usage: node convert.cjs <input-file> [pptx|pdf|html] [--theme name] [--editable-pptx]');
  process.exit(1);
}

const inputFile = path.resolve(process.cwd(), inputFilePath);
const skillRoot = path.resolve(__dirname, '..');
const projectRoot = path.resolve(skillRoot, '..');
const knowledgeThemesDir = path.join(projectRoot, 'knowledge', 'templates', 'themes');
const localThemesDir = path.join(skillRoot, 'assets', 'themes');

const outputFile = inputFile.replace(/\.(md|markdown)$/i, '') + '.' + outputFormat;

if (isEditable && outputFormat === 'pptx') {
    logger.info('Generating EDITABLE PPTX via python-pptx bridge...');
    // In a real scenario, we call a python script that parses the MD and uses python-pptx
    // For this simulation, we'll demonstrate the command routing.
    const pythonScript = path.join(projectRoot, 'layout-architect/scripts/md_to_pptx.py');
    try {
        execSync(`python3 "${pythonScript}" "${inputFile}" "${outputFile}"`, { stdio: 'inherit' });
        logger.success(`Editable PPTX Created: ${outputFile}`);
        process.exit(0);
    } catch (e) {
        logger.warn('Python bridge failed or python-pptx not found. Falling back to Marp image-based PPTX.');
    }
}

// Fallback to Marp (Standard Image-based PPTX)
console.log(`Converting '${inputFile}' to ${outputFormat.toUpperCase()} (Marp Mode)...`);

const themeSets = [];
if (fs.existsSync(localThemesDir)) themeSets.push(localThemesDir);
if (fs.existsSync(knowledgeThemesDir)) themeSets.push(knowledgeThemesDir);

let command = `npx -y @marp-team/marp-cli "${inputFile}" -o "${outputFile}" --allow-local-files`;

if (themeSets.length > 0) {
  command += ` --theme-set ${themeSets.map(d => `"${d}"`).join(' ')}`;
}

if (customTheme) {
  const themePath = path.join(knowledgeThemesDir, `${customTheme}.css`);
  if (fs.existsSync(themePath)) {
    command += ` --theme "${themePath}"`;
  } else {
    command += ` --theme ${customTheme}`;
  }
}

try {
  execSync(command, { stdio: 'inherit' });
  logger.success(`PPTX Created: ${outputFile}`);
} catch (error) {
  errorHandler(error, 'Conversion Failed');
}