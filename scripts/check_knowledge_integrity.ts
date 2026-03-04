/**
 * scripts/check_knowledge_integrity.ts
 * Scans knowledge base for broken links and metadata inconsistencies.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger } from '@agent/core';

const ROOT_DIR = process.cwd();
const KNOWLEDGE_DIR = path.join(ROOT_DIR, 'knowledge');

function walk(dir: string, fileList: string[] = []): string[] {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const filePath = path.join(dir, file);
    if (fs.statSync(filePath).isDirectory()) {
      if (!['node_modules', '.git', 'dist'].includes(file)) walk(filePath, fileList);
    } else if (file.endsWith('.md')) {
      fileList.push(filePath);
    }
  }
  return fileList;
}

async function checkIntegrity() {
  logger.info('🛡️  Scanning Knowledge Integrity...');
  const files = walk(KNOWLEDGE_DIR);
  let brokenLinks = 0;
  let totalLinks = 0;

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    const relFile = path.relative(KNOWLEDGE_DIR, file);
    
    // Match [label](./path/to/file.md) but NOT `[label](./path/to/file.md)`
    const linkRegex = /(?<!`)\[([^\]]+)\]\(([^)]+)\)(?!`)/g;
    let match;

    while ((match = linkRegex.exec(content)) !== null) {
      const label = match[1];
      const link = match[2];

      if (link.startsWith('http') || link.startsWith('#')) continue;
      
      totalLinks++;
      const linkPath = path.resolve(path.dirname(file), link);
      
      if (!fs.existsSync(linkPath)) {
        logger.error(`❌ Broken link in ${relFile}: [${label}](${link})`);
        brokenLinks++;
      } else {
        // Optional: Title mismatch check
        const targetContent = fs.readFileSync(linkPath, 'utf8');
        const titleMatch = targetContent.match(/^# (.*)/m);
        if (titleMatch) {
          const targetTitle = titleMatch[1].trim();
          if (label !== targetTitle && !label.includes(targetTitle) && !targetTitle.includes(label)) {
            // logger.warn(`⚠️ Title mismatch in ${relFile}: Label "${label}" vs Target "${targetTitle}"`);
          }
        }
      }
    }
  }

  if (brokenLinks === 0) {
    logger.success(`✨ Knowledge Shield: All ${totalLinks} internal links are valid.`);
  } else {
    logger.error(`🚨 Found ${brokenLinks} broken links out of ${totalLinks} total.`);
    process.exit(1);
  }
}

checkIntegrity().catch(e => logger.error(e.message));
