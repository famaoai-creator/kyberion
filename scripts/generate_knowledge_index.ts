import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import { detectTier } from '@agent/core/tier-guard';
import { safeWriteFile, safeReadFile } from '@agent/core';

const rootDir = process.cwd();
const knowledgeDir = path.join(rootDir, 'knowledge');
const jsonPath = path.join(knowledgeDir, 'orchestration/knowledge_index.json');
const mdIndexPath = path.join(knowledgeDir, '_index.md');

interface KnowledgeMeta {
  title: string;
  author: string;
  last_updated: string;
  tier: string;
}

interface KnowledgeItem extends KnowledgeMeta {
  id: string;
  category: string;
}

function extractMetadata(content: string, filePath: string): KnowledgeMeta {
  const meta: KnowledgeMeta = {
    title: '',
    author: 'Unknown',
    last_updated: '',
    tier: detectTier(filePath),
  };

  const titleMatch = content.match(/^# (.*)/m);
  meta.title = titleMatch ? titleMatch[1] : path.basename(filePath, '.md');

  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const fm = fmMatch[1];
    const authorMatch = fm.match(/^author:\s*(.*)$/m);
    const dateMatch = fm.match(/^last_updated:\s*(.*)$/m);
    if (authorMatch) meta.author = authorMatch[1].trim();
    if (dateMatch) meta.last_updated = dateMatch[1].trim();
  }

  if (!meta.last_updated) {
    const stats = fs.statSync(filePath);
    meta.last_updated = stats.mtime.toISOString().split('T')[0];
  }

  return meta;
}

function walk(dir: string, fileList: KnowledgeItem[] = []): KnowledgeItem[] {
  if (!fs.existsSync(dir)) return fileList;
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
      if (file.startsWith('.') || file === 'node_modules' || file === 'incidents') return;
      walk(filePath, fileList);
    } else if (file.endsWith('.md') && file !== '_index.md' && file !== 'README.md') {
      const relPath = path.relative(knowledgeDir, filePath);
      const content = safeReadFile(filePath, { encoding: 'utf8' }) as string;
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

  const ssotData = {
    v: '2.0.0',
    t: index.length,
    u: new Date().toISOString(),
    items: index,
  };

  const jsonDir = path.dirname(jsonPath);
  if (!fs.existsSync(jsonDir)) {
    fs.mkdirSync(jsonDir, { recursive: true });
  }
  safeWriteFile(jsonPath, JSON.stringify(ssotData, null, 2));
  console.log(chalk.green(`  ✔ Generated SSoT JSON index (${index.length} assets recorded)`));

  // Mirror Sensory Feed
  const stimuliPath = path.join(rootDir, 'presence/bridge/runtime/stimuli.jsonl');
  const mirrorStimuliPath = path.join(rootDir, 'presence/displays/chronos-mirror/public/stimuli_feed.json');
  if (fs.existsSync(stimuliPath)) {
    try {
      const raw = fs.readFileSync(stimuliPath, 'utf8').trim().split('\n');
      const recent = raw.slice(-15).map(line => JSON.parse(line));
      safeWriteFile(mirrorStimuliPath, JSON.stringify(recent, null, 2));
      console.log(chalk.green(`  ✔ Mirrored recent stimuli to Dashboard`));
    } catch (e: any) {
      console.warn(chalk.yellow(`  ⚠️ Failed to mirror stimuli: ${e.message}`));
    }
  }

  const mirrorPath = path.join(rootDir, 'tools/chronos-mirror/public/knowledge_index.json');
  const mirrorDir = path.dirname(mirrorPath);
  if (fs.existsSync(mirrorDir)) {
    safeWriteFile(mirrorPath, JSON.stringify(index, null, 2));
    console.log(chalk.green(`  ✔ Mirrored index to Chronos Mirror`));
  }

  let mdContent = `# Ecosystem Knowledge Base Index\n\n`;
  mdContent += `*SSoT Index Version: 2.0.0 | Last Updated: ${ssotData.u}*\n\n`;

  const categories = [...new Set(index.map((f) => f.category))].sort();
  categories.forEach((cat) => {
    mdContent += `## 📁 ${cat === '.' ? 'General' : cat}\n`;
    index
      .filter((f) => f.category === cat)
      .forEach((f) => {
        mdContent += `- [${f.title}](./${f.id}) (${f.tier} | ${f.author})\n`;
      });
    mdContent += `\n`;
  });

  safeWriteFile(mdIndexPath, mdContent);
  console.log(chalk.green(`  ✔ Updated knowledge/_index.md`));

  console.log(chalk.bold.green('\n✨ Knowledge Integrity Maintained.\n'));

} catch (err: any) {
  console.error(chalk.red(`Failed to sync knowledge indices: ${err.message}`));
}
