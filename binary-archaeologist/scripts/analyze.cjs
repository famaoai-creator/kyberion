#!/usr/bin/env node
const { safeWriteFile } = require('../../scripts/lib/secure-io.cjs');
const fs = require('fs'); const path = require('path');
 const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');
const argv = createStandardYargs()
  .option('input', { alias: 'i', type: 'string', demandOption: true, description: 'Path to binary or executable file' })
  .option('out', { alias: 'o', type: 'string', description: 'Output file path' })
  .help().argv;

function analyzeBinary(filePath) {
  const stat = fs.statSync(filePath);
  const buffer = Buffer.alloc(Math.min(8192, stat.size));
  const fd = fs.openSync(filePath, 'r');
  fs.readSync(fd, buffer, 0, buffer.length, 0);
  fs.closeSync(fd);

  const magic = buffer.slice(0, 4).toString('hex');
  const format = detectFormat(magic, buffer);
  const strings = extractStrings(buffer);
  const imports = detectImports(strings);

  return { size: stat.size, format, magic, stringsFound: strings.length, imports, sampleStrings: strings.slice(0, 20) };
}

function detectFormat(magic, buffer) {
  if (magic === '7f454c46') return 'ELF (Linux executable)';
  if (magic.startsWith('4d5a')) return 'PE (Windows executable)';
  if (magic.startsWith('cafebabe')) return 'Java class / Mach-O fat binary';
  if (magic.startsWith('feedface') || magic.startsWith('feedfacf')) return 'Mach-O (macOS executable)';
  if (magic.startsWith('504b0304')) return 'ZIP archive (JAR/APK/WASM)';
  if (buffer.toString('utf8', 0, 2) === '#!') return 'Script with shebang';
  if (buffer.toString('utf8', 0, 20).includes('<?xml')) return 'XML document';
  return 'Unknown binary format';
}

function extractStrings(buffer) {
  const strings = [];
  let current = '';
  for (let i = 0; i < buffer.length; i++) {
    const c = buffer[i];
    if (c >= 32 && c < 127) { current += String.fromCharCode(c); }
    else { if (current.length >= 4) strings.push(current); current = ''; }
  }
  if (current.length >= 4) strings.push(current);
  return strings;
}

function detectImports(strings) {
  const libs = [];
  for (const s of strings) {
    if (/\.so\b|\.dll\b|\.dylib\b/i.test(s)) libs.push(s);
    if (/^lib[a-z]/i.test(s) && s.length < 50) libs.push(s);
  }
  return [...new Set(libs)].slice(0, 20);
}

runSkill('binary-archaeologist', () => {
  const resolved = path.resolve(argv.input);
  if (!fs.existsSync(resolved)) throw new Error(`File not found: ${resolved}`);
  const analysis = analyzeBinary(resolved);
  const result = {
    source: path.basename(resolved), ...analysis,
    recommendations: [
      analysis.format.includes('Unknown') ? 'Unable to identify format - may need specialized tools' : `Identified as ${analysis.format}`,
      analysis.imports.length > 0 ? `Found ${analysis.imports.length} library dependencies` : 'No library imports detected in header',
    ],
  };
  if (argv.out) safeWriteFile(argv.out, JSON.stringify(result, null, 2));
  return result;
});
