#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const { detectTier } = require('../libs/core/tier-guard.cjs');

const rootDir = path.resolve(__dirname, '..');
const knowledgeDir = path.join(rootDir, 'knowledge');
const jsonPath = path.join(knowledgeDir, 'orchestration/knowledge_index.json');
const mdIndexPath = path.join(knowledgeDir, '_index.md');

/**
 * Knowledge Indexer v2.0 - Governance & Protocol Aware
 */

function extractMetadata(content, filePath) {
  const meta = {
    title: '',
    author: 'Unknown',
    last_updated: '',
    tier: detectTier(filePath),
  };

  // Extract Title
  const titleMatch = content.match(/^# (.*)/m);
  meta.title = titleMatch ? titleMatch[1] : path.basename(filePath, '.md');

  // Extract Frontmatter
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const fm = fmMatch[1];
    const authorMatch = fm.match(/^author:\s*(.*)$/m);
    const dateMatch = fm.match(/^last_updated:\s*(.*)$/m);
    if (authorMatch) meta.author = authorMatch[1].trim();
    if (dateMatch) meta.last_updated = dateMatch[1].trim();
  }

  // Fallback date
  if (!meta.last_updated) {
    const stats = fs.statSync(filePath);
    meta.last_updated = stats.mtime.toISOString().split('T')[0];
  }

  return meta;
}

function walk(dir, fileList = []) {
  const files = fs.readdirSync(dir);
  files.forEach((file) => {
    const filePath = path.join(dir, file);
    let isDir = false;
    try {
      isDir = fs.statSync(filePath).isDirectory();
    } catch (_e) {
      return;
    }

    if (isDir) {
      // 隠しディレクトリや特定のシステムディレクトリをスキップ
      if (file.startsWith('.') || file === 'node_modules' || file === 'incidents') return;
      walk(filePath, fileList);
    } else if (file.endsWith('.md') && file !== '_index.md' && file !== 'README.md') {
      const relPath = path.relative(knowledgeDir, filePath);
      const content = fs.readFileSync(filePath, 'utf8');
      const metadata = extractMetadata(content, filePath);

      fileList.push({
        id: relPath,
        ...metadata,
        category: path.dirname(relPath),
      });
    }
  });
  return fileList;
}

try {
  console.log(chalk.cyan('\n🔍 Synchronizing Knowledge Ecosystem Index...'));
  const index = walk(knowledgeDir);

  // 1. Generate SSoT JSON index
  const ssotData = {
    v: '2.0.0',
    t: index.length,
    u: new Date().toISOString(),
    items: index,
  };

  if (!fs.existsSync(path.dirname(jsonPath)))
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify(ssotData, null, 2));
  console.log(chalk.green(`  ✔ Generated SSoT JSON index (${index.length} assets recorded)`));

  // 2. Mirror to Chronos Mirror public (for frontend)
  const mirrorPath = path.join(rootDir, 'tools/chronos-mirror/public/knowledge_index.json');
  if (fs.existsSync(path.dirname(mirrorPath))) {
    fs.writeFileSync(mirrorPath, JSON.stringify(index, null, 2));
    console.log(chalk.green(`  ✔ Mirrored index to Chronos Mirror`));
  }

  // 3. Generate Markdown for Git/Human view
  let mdContent = `# Ecosystem Knowledge Base Index\n\n`;
  mdContent += `*SSoT Index Version: 2.0.0 | Last Updated: ${ssotData.u}*\n\n`;

  const categories = [...new Set(index.map((f) => f.category))].sort();
  categories.forEach((cat) => {
    mdContent += `## 📁 ${cat === '.' ? 'General' : cat}\n`;
    index
      .filter((f) => f.category === cat)
      .forEach((f) => {
        mdContent += `- [${f.title}](./${f.id}) ${chalk.dim(`(${f.tier} | ${f.author})`)}\n`;
      });
    mdContent += `\n`;
  });

  fs.writeFileSync(mdIndexPath, mdContent.replace(/\u001b\[\d+m/g, '')); // Strip chalk for MD
  console.log(chalk.green(`  ✔ Updated knowledge/_index.md`));

  console.log(chalk.bold.green(`\n✨ Knowledge Integrity Maintained.\n`));
} catch (err) {
  console.error(chalk.red(`Failed to sync knowledge indices: ${err.message}`));
}
