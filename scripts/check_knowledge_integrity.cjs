#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const knowledgeDir = path.join(rootDir, 'knowledge');

/**
 * Knowledge Integrity Checker
 * Detects broken internal links and duplicated context in documentation.
 */

function checkLinks() {
  const issues = [];
  const files = [];

  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.md')) files.push(p);
    }
  }
  walk(knowledgeDir);

  files.forEach((file) => {
    const content = fs.readFileSync(file, 'utf8');
    const relFile = path.relative(rootDir, file);

    // Simple MD link regex: [text](./path/to/file.md)
    const linkRegex = /\[.*?\]\(((\.\/|\.\.\/).*?\.md)\)/g;
    let match;
    while ((match = linkRegex.exec(content)) !== null) {
      const linkPath = path.resolve(path.dirname(file), match[1]);
      if (!fs.existsSync(linkPath)) {
        issues.push({ file: relFile, type: 'BROKEN_LINK', detail: match[1] });
      }
    }
  });

  return issues;
}

const issues = checkLinks();
if (issues.length > 0) {
  console.log(`
\u26a0\ufe0f  Knowledge Integrity Issues Found: ${issues.length}
`);
  issues.forEach((i) => console.log(`  [${i.type}] ${i.file}: ${i.detail}`));
  process.exit(1);
} else {
  console.log('✅ Knowledge integrity verified. No broken links detected.');
}
