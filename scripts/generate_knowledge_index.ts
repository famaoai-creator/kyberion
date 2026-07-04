import * as path from 'node:path';
import {
  pathResolver,
  safeExistsSync,
  safeLstat,
  safeReadFile,
  safeReaddir,
  safeStat,
  safeWriteFile,
  withExecutionContext,
} from '@agent/core';

interface ManifestEntry {
  path: string;
  tier: string;
  size: number;
  type: string;
}

interface IndexEntry {
  path: string;
  title: string;
  author: string;
  dir: string;
  tier: string;
}

function getTier(relPath: string): string {
  if (relPath.startsWith('personal/')) return 'personal';
  if (relPath.startsWith('confidential/')) return 'confidential';
  return 'public';
}

function parseMarkdownMetadata(filePath: string): { title: string; author: string } {
  try {
    const content = safeReadFile(filePath, { encoding: 'utf8' }) as string;
    let title = path.basename(filePath, '.md');
    let author = 'Unknown';

    // Parse YAML frontmatter
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (match) {
      const fm = match[1];
      const titleMatch = fm.match(/^title:\s*(.*)$/m);
      if (titleMatch) title = titleMatch[1].replace(/["']/g, '').trim();
      const authorMatch = fm.match(/^author:\s*(.*)$/m) || fm.match(/^owner:\s*(.*)$/m);
      if (authorMatch) author = authorMatch[1].replace(/["']/g, '').trim();
    } else {
      // Fallback to first h1
      const h1Match = content.match(/^#\s+(.*)$/m);
      if (h1Match) title = h1Match[1].trim();
    }
    return { title, author };
  } catch {
    return { title: path.basename(filePath, '.md'), author: 'Unknown' };
  }
}

function walk(dir: string, baseDir: string, files: string[] = []): string[] {
  if (!safeExistsSync(dir)) return files;
  const entries = safeReaddir(dir);
  for (const entry of entries) {
    if (entry.startsWith('.') || entry === 'node_modules' || entry === 'dist') continue;
    // Tier invariant: the root index/manifest are public-tier artifacts, so
    // higher-tier paths and titles must never be listed there (AGENTS.md §1).
    if (dir === baseDir && (entry === 'personal' || entry === 'confidential')) continue;
    const fullPath = path.join(dir, entry);
    const stat = safeLstat(fullPath);
    if (stat.isDirectory()) {
      walk(fullPath, baseDir, files);
    } else if (stat.isFile()) {
      const ext = path.extname(entry).toLowerCase();
      // Keep only md, json, txt, etc if they were in the previous manifest? Wait, let's just index md and json for now, maybe py and js.
      if (['.md', '.json', '.txt', '.csv', '.yml', '.yaml', '.js', '.ts', '.py', '.sh'].includes(ext)) {
        files.push(path.relative(baseDir, fullPath).replace(/\\/g, '/'));
      }
    }
  }
  return files;
}

export function generateIndex(checkOnly = false): boolean {
  // Index generation is a governance tool that must see every tier and write
  // the tier-root index files, so run it elevated (same pattern as scripts/clean.ts).
  return withExecutionContext('mission_controller', () => {
    const previousSudo = process.env.KYBERION_SUDO;
    process.env.KYBERION_SUDO = 'true';
    try {
      return generateIndexInner(checkOnly);
    } finally {
      if (previousSudo === undefined) delete process.env.KYBERION_SUDO;
      else process.env.KYBERION_SUDO = previousSudo;
    }
  });
}

function generateIndexInner(checkOnly: boolean): boolean {
  const kbRoot = pathResolver.knowledge('');
  const allFiles = walk(kbRoot, kbRoot);

  const manifestEntries: ManifestEntry[] = [];
  const indexEntries: IndexEntry[] = [];

  for (const file of allFiles) {
    if (file === '_index.md' || file === '_manifest.json') continue;
    const fullPath = path.join(kbRoot, file);
    const stat = safeStat(fullPath);
    const tier = getTier(file);
    const ext = path.extname(file).replace('.', '');

    manifestEntries.push({
      path: file,
      tier,
      size: stat.size,
      type: ext || 'unknown'
    });

    if (ext === 'md') {
      const { title, author } = parseMarkdownMetadata(fullPath);
      let dir = path.dirname(file);
      if (dir === '.') dir = 'General';
      
      indexEntries.push({
        path: `./${file}`,
        title,
        author,
        dir,
        tier
      });
    }
  }

  manifestEntries.sort((a, b) => a.path.localeCompare(b.path));
  const manifestData = {
    generated: new Date().toISOString(), // In check mode we ignore this field
    files: manifestEntries
  };
  const manifestContent = JSON.stringify(manifestData, null, 2);

  const grouped: Record<string, IndexEntry[]> = {};
  for (const entry of indexEntries) {
    if (!grouped[entry.dir]) grouped[entry.dir] = [];
    grouped[entry.dir].push(entry);
  }

  const dirs = Object.keys(grouped).sort();

  // For checkOnly mode, we don't compare the Last Updated string, so we generate a normalized version
  let md = `# Ecosystem Knowledge Base Index\n\n`;
  md += `*SSoT Index Version: 2.0.0 | Last Updated: ${new Date().toISOString()}*\n\n`;
  md += `> **Volatile / Working-Memory faces** (session, mission, project, personal, daily, weekly) are **not listed here** — they are ephemeral and not SSoT. See the generated volatile index: [\`active/INDEX.volatile.md\`](../active/INDEX.volatile.md) (non-SSoT, refreshed by \`pnpm pipeline --input pipelines/volatile-index.json\`). Schema: \`schemas/volatile-knowledge.schema.json\`.\n\n`;

  for (const dir of dirs) {
    md += `## 📁 ${dir}\n`;
    grouped[dir].sort((a, b) => a.title.localeCompare(b.title));
    for (const entry of grouped[dir]) {
      md += `- [${entry.title}](${entry.path}) (${entry.tier} | ${entry.author})\n`;
    }
    md += `\n`;
  }
  const indexContent = md.trim() + '\n';

  if (checkOnly) {
    const existingManifest = safeReadFile(path.join(kbRoot, '_manifest.json'), {
      encoding: 'utf8',
    }) as string;
    const existingIndex = safeReadFile(path.join(kbRoot, '_index.md'), {
      encoding: 'utf8',
    }) as string;
    
    // Ignore dynamic dates
    const normalize = (str: string) => str.replace(/Last Updated:.*?\*/g, '').replace(/"generated": ".*?"/g, '');
    if (normalize(existingManifest) !== normalize(manifestContent) || normalize(existingIndex) !== normalize(indexContent)) {
      console.error('[generate_knowledge_index] Index or manifest is out of date. Run pnpm generate:knowledge-index to update.');
      return false;
    }
    return true;
  }

  safeWriteFile(path.join(kbRoot, '_manifest.json'), manifestContent);
  safeWriteFile(path.join(kbRoot, '_index.md'), indexContent);
  return true;
}

const isDirectExecution = process.argv[1] != null && (process.argv[1].endsWith('generate_knowledge_index.ts') || process.argv[1].endsWith('generate_knowledge_index.js'));
if (isDirectExecution) {
  const checkOnly = process.argv.includes('--check');
  const success = generateIndex(checkOnly);
  if (!success && checkOnly) {
    process.exit(1);
  }
  if (!checkOnly) {
    console.log('[generate_knowledge_index] Index and manifest updated successfully.');
  } else {
    console.log('[generate_knowledge_index] Index and manifest are up-to-date.');
  }
}
