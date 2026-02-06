const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const inputFile = process.argv[2];
const outputDir = process.argv[3] || 'extracted_images';

if (!inputFile) {
  console.error('Usage: node extract_images.cjs <pptx_file> [output_dir]');
  process.exit(1);
}

const absInput = path.resolve(inputFile);
const absOutput = path.resolve(outputDir);

if (!fs.existsSync(absInput)) {
  console.error(`Error: File not found: ${absInput}`);
  process.exit(1);
}

// Prepare output directory
if (!fs.existsSync(absOutput)) {
  fs.mkdirSync(absOutput, { recursive: true });
}

console.log(`Extracting images from '${path.basename(absInput)}' to '${outputDir}'...`);

try {
  // Use unzip to extract only media files
  // ppt/media/ directory contains images in a pptx file (which is a zip)
  // -j: junk paths (flatten directory structure)
  // -q: quiet
  // -d: destination
  execSync(`unzip -j -q "${absInput}" "ppt/media/*" -d "${absOutput}"`, { stdio: 'inherit' });
  
  // List extracted files
  const files = fs.readdirSync(absOutput);
  console.log(`
✅ Extracted ${files.length} images.`);
  if (files.length > 0) {
    console.log('Sample files:', files.slice(0, 5).join(', '));
  }
} catch (error) {
  console.error('\n❌ Extraction failed. Is "unzip" installed? Is the file a valid PPTX?');
  process.exit(1);
}
