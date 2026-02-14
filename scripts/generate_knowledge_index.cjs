#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');

const rootDir = path.resolve(__dirname, '..');
const knowledgeDir = path.join(rootDir, 'knowledge');
const jsonPath = path.join(rootDir, 'tools/chronos-mirror/public/knowledge_index.json');
const mdIndexPath = path.join(knowledgeDir, '_index.md');

/**
 * Unified Knowledge Indexer
 * Synchronizes both Chronos Mirror (JSON) and Git/Obsidian (_index.md).
 */

function walk(dir, fileList = []) {
  const files = fs.readdirSync(dir);
  files.forEach((file) => {
    const filePath = path.join(dir, file);
    let isDir = false;
    try {
      isDir = fs.statSync(filePath).isDirectory();
    } catch (_e) {
      return; // Skip broken symlinks or non-stat-able entries
    }
    if (isDir) {
      if (file === 'personal' || file === 'confidential') return; // 秘密情報はスキップ
      walk(filePath, fileList);
    } else if (file.endsWith('.md') && file !== '_index.md' && file !== 'README.md') {
      const relPath = path.relative(knowledgeDir, filePath);
      const content = fs.readFileSync(filePath, 'utf8');
      const titleMatch = content.match(/^# (.*)/m);
      const title = titleMatch ? titleMatch[1] : path.basename(file, '.md');

      fileList.push({
        id: relPath,
        title: title,
        path: `/knowledge_src/${relPath}`,
        category: path.dirname(relPath),
      });
    }
  });
  return fileList;
}

try {
  console.log(chalk.cyan('\n\u23f3 Synchronizing Knowledge Indices...'));
  const index = walk(knowledgeDir);

  // 1. Generate JSON for Chronos Mirror
  if (!fs.existsSync(path.dirname(jsonPath)))
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify(index, null, 2));
  console.log(chalk.green(`  \u2714 Generated JSON index (${index.length} docs)`));

  // 2. Generate Markdown for Git/Obsidian (_index.md)
  let mdContent = `# Ecosystem Knowledge Base Index\n\n`;
  mdContent += `*Last Updated: ${new Date().toISOString()}*\n\n`;

  // カテゴリごとにグルーピング
  const categories = [...new Set(index.map((f) => f.category))].sort();
  categories.forEach((cat) => {
    mdContent += `## 📁 ${cat === '.' ? 'General' : cat}\n`;
    index
      .filter((f) => f.category === cat)
      .forEach((f) => {
        mdContent += `- [${f.title}](./${f.id})\n`;
      });
    mdContent += `\n`;
  });

  fs.writeFileSync(mdIndexPath, mdContent);
  console.log(chalk.green(`  \u2714 Updated knowledge/_index.md`));

  console.log(chalk.bold.green(`\n\u2728 All indices are now consistent.\n`));
} catch (err) {
  console.error(chalk.red(`Failed to sync indices: ${err.message}`));
}
