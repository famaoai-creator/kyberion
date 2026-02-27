#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const glob = require('glob');

const rootDir = path.resolve(__dirname, '..');

/**
 * Mass Refactoring Tool for Governance Enforcement v2.0
 * Standardizes imports and usage of secure-io and wrappers.
 */

function refactorFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  let modified = false;

  // 1. Replace fs.writeFileSync -> safeWriteFile
  if (content.includes('fs.writeFileSync(') && !content.includes('process.argv')) {
    content = content.replace(/fs\.writeFileSync\(/g, 'safeWriteFile(');
    modified = true;
  }

  // 2. Replace fs.readFileSync -> safeReadFile
  if (content.includes('fs.readFileSync(') && !content.includes('process.argv')) {
    content = content.replace(/fs\.readFileSync\(/g, 'safeReadFile(');
    modified = true;
  }

  if (modified) {
    // 3. Ensure proper imports
    if (!content.includes("'@agent/core/secure-io'")) {
      const importLine = "import { safeWriteFile, safeReadFile } from '@agent/core/secure-io';\n";
      if (content.includes('import {')) {
        content = importLine + content;
      } else {
        // Fallback for CJS or other
        content = "const { safeWriteFile, safeReadFile } = require('@agent/core/secure-io');\n" + content;
      }
    }
  }

  if (modified) {
    fs.writeFileSync(filePath, content, 'utf8');
    return true;
  }
  return false;
}

const files = glob.sync('skills/**/src/*.ts', { cwd: rootDir });
let total = 0;

console.log(`Scanning ${files.length} files for governance refactoring...`);

files.forEach((file) => {
  if (refactorFile(path.join(rootDir, file))) {
    console.log(`  [FIXED] ${file}`);
    total++;
  }
});

console.log(`\nRefactoring complete. ${total} files updated.`);
