const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const inputFile = process.argv[2];
const outputFormat = process.argv[3] || 'pptx'; // default to pptx

if (!inputFile) {
  console.error('Error: Input file is required.');
  console.log('Usage: node convert.cjs <input-file> [pptx|pdf|html]');
  process.exit(1);
}

// Resolve paths
const skillRoot = path.resolve(__dirname, '..');
const themesDir = path.join(skillRoot, 'assets', 'themes');
const outputFile = inputFile.replace(/\.(md|markdown)$/i, '') + '.' + outputFormat;

console.log(`Converting '${inputFile}' to ${outputFormat.toUpperCase()}...`);

// Construct command
// Using npx to run marp-cli without global install
// --theme-set points to our custom themes
// --allow-local-files is needed for local images
const command = `npx -y @marp-team/marp-cli "${inputFile}" -o "${outputFile}" --theme-set "${themesDir}" --allow-local-files`;

try {
  execSync(command, { stdio: 'inherit' });
  console.log(`\n✅ Success! Created: ${outputFile}`);
} catch (error) {
  console.error('\n❌ Conversion failed.');
  process.exit(1);
}

