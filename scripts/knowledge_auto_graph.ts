/**
 * scripts/knowledge_auto_graph.ts
 * Discovers relationships between knowledge assets and generates Mermaid maps.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger, safeReadFile, safeWriteFile } from '@agent/core';

const ROOT_DIR = process.cwd();
const KNOWLEDGE_DIR = path.join(ROOT_DIR, 'knowledge');
const ECO_MAP_PATH = path.join(KNOWLEDGE_DIR, 'Ecosystem_Map.md');

interface DocMeta {
  id: string;
  title: string;
  absPath: string;
  links: string[];
}

function walk(dir: string, fileList: string[] = []): string[] {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const filePath = path.join(dir, file);
    if (fs.statSync(filePath).isDirectory()) {
      if (!['node_modules', '.git', 'dist'].includes(file)) walk(filePath, fileList);
    } else if (file.endsWith('.md') && file !== 'README.md' && file !== '_index.md' && file !== 'Ecosystem_Map.md') {
      fileList.push(filePath);
    }
  }
  return fileList;
}

async function runAutoGraph() {
  logger.info('🔍 Analyzing Knowledge relationships...');
  const files = walk(KNOWLEDGE_DIR);
  const docs: DocMeta[] = [];

  // 1. Build Index
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    const titleMatch = content.match(/^# (.*)/m);
    const title = titleMatch ? titleMatch[1].trim() : path.basename(file, '.md');
    docs.push({
      id: path.relative(KNOWLEDGE_DIR, file),
      title,
      absPath: file,
      links: []
    });
  }

  // 2. Discover Links (Simple Title Match)
  for (const source of docs) {
    const content = fs.readFileSync(source.absPath, 'utf8');
    for (const target of docs) {
      if (source.id === target.id) continue;
      // Search for literal title or relative path in content
      if (content.includes(target.title) || content.includes(target.id)) {
        source.links.push(target.title);
      }
    }
  }

  // 3. Generate Mermaid Map
  let mermaid = '```mermaid\ngraph TD\n';
  for (const doc of docs) {
    const shortTitle = doc.title.substring(0, 30);
    const sanitizedId = doc.id.replace(/\//g, '_').replace(/\./g, '_').replace(/-/g, '_');
    mermaid += `    ${sanitizedId}["${shortTitle}"]\n`;
    for (const link of doc.links) {
      const target = docs.find(d => d.title === link);
      if (target) {
        const targetId = target.id.replace(/\//g, '_').replace(/\./g, '_').replace(/-/g, '_');
        mermaid += `    ${sanitizedId} --> ${targetId}\n`;
      }
    }
  }
  mermaid += '```\n';

  const ecoMapContent = `# Ecosystem Knowledge Map\n\nAutomatically generated graph of knowledge relationships.\n\n${mermaid}`;
  safeWriteFile(ECO_MAP_PATH, ecoMapContent);
  logger.success(`✅ Knowledge Map generated at ${ECO_MAP_PATH}`);

  // 4. Inject "Related Knowledge" into individual files (Only for major docs)
  for (const doc of docs) {
    if (doc.links.length > 0 && doc.id.startsWith('architecture/')) {
      let content = fs.readFileSync(doc.absPath, 'utf8');
      if (!content.includes('## 🔗 Related Knowledge')) {
        const linksSection = `\n\n## 🔗 Related Knowledge\n${doc.links.map(l => `- ${l}`).join('\n')}\n`;
        content += linksSection;
        safeWriteFile(doc.absPath, content);
      }
    }
  }
}

runAutoGraph().catch(e => logger.error(e.message));
