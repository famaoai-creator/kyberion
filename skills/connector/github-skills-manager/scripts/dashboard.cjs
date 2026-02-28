#!/usr/bin/env node
const { execSync } = require('child_process');
const path = require('path');

try {
  const indexScript = path.join(__dirname, '../dist/index.js');
  // Pass all arguments to the underlying script
  const args = process.argv.slice(2).join(' ');
  execSync(`node "${indexScript}" ${args}`, { stdio: 'inherit' });
} catch (e) {
  process.exit(e.status || 1);
}
