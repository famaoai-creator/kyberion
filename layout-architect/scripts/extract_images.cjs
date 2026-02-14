const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');

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

runSkill('layout-architect', () => {
  // Prepare output directory
  if (!fs.existsSync(absOutput)) {
    fs.mkdirSync(absOutput, { recursive: true });
  }

  // Use unzip to extract only media files
  // ppt/media/ directory contains images in a pptx file (which is a zip)
  execSync(`unzip -j -q "${absInput}" "ppt/media/*" -d "${absOutput}"`, { stdio: 'inherit' });

  // List extracted files
  const files = fs.readdirSync(absOutput);

  return {
    input: path.basename(absInput),
    outputDir: absOutput,
    extractedCount: files.length,
    sampleFiles: files.slice(0, 5),
  };
});
