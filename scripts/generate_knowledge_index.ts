import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import {
  safeExistsSync,
  safeLstat,
  safeReadFile,
  safeReaddir,
  safeStat,
  safeWriteFile,
} from '@agent/core/secure-io';
import { withExecutionContext } from '@agent/core/governance';
import { readJson } from '@agent/core/foundation';
import { defineGenerator, isDirectScript, type GeneratedFile } from './lib/harness.js';

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

interface FrontmatterExclusionManifest {
  manifest_version: number;
  excluded_paths: string[];
}

const FRONTMATTER_EXCLUSIONS_PATH = pathResolver.knowledge(
  'product/governance/frontmatter-exclusions.json'
);
const KNOWLEDGE_INDEX_PATH = pathResolver.knowledge('_index.md');
const KNOWLEDGE_MANIFEST_PATH = pathResolver.knowledge('_integrity-manifest.json');

function matchesExclusion(relativePath: string, pattern: string): boolean {
  const expression = new RegExp(
    `^${pattern
      .split('**')
      .map((part) =>
        part
          .split('*')
          .map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('[^/]*')
      )
      .join('.*')}$`
  );
  return expression.test(relativePath);
}

export function validateFrontmatterExclusions(files: readonly string[]): string[] {
  const manifest = readJson<FrontmatterExclusionManifest>(FRONTMATTER_EXCLUSIONS_PATH);
  const failures: string[] = [];
  if (manifest.manifest_version !== 1 || !Array.isArray(manifest.excluded_paths)) {
    return ['frontmatter exclusion manifest has an unsupported shape'];
  }
  for (const pattern of manifest.excluded_paths) {
    // These roots are intentionally omitted by `walk` for tier isolation and
    // runtime volatility, so their exclusion is validated by the walker
    // policy rather than by a visible index entry.
    if (pattern === 'personal/**' || pattern.startsWith('product/evolution/')) continue;
    if (!files.some((file) => matchesExclusion(file, pattern))) {
      failures.push(`frontmatter exclusion does not match any knowledge path: ${pattern}`);
    }
  }
  return failures;
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

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

function trySafeLstat(filePath: string): ReturnType<typeof safeLstat> | undefined {
  try {
    return safeLstat(filePath);
  } catch (error) {
    // Knowledge checks can run alongside short-lived governance probes. If a
    // file disappears after directory enumeration, omit that ephemeral entry
    // while preserving permission and other I/O failures.
    if (isMissingPathError(error)) return undefined;
    throw error;
  }
}

function trySafeStat(filePath: string): ReturnType<typeof safeStat> | undefined {
  try {
    return safeStat(filePath);
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw error;
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
    // Evolution dirs receive runtime distill output; indexing them would make
    // the committed manifest stale after every learning cycle (same volatility
    // class as HINTS.md).
    if (dir === baseDir && entry === 'evolution') continue;
    const fullPath = path.join(dir, entry);
    const stat = trySafeLstat(fullPath);
    if (!stat) continue;
    if (stat.isDirectory()) {
      if (path.relative(baseDir, fullPath).replace(/\\/g, '/') === 'product/evolution') continue;
      walk(fullPath, baseDir, files);
    } else if (stat.isFile()) {
      const ext = path.extname(entry).toLowerCase();
      // Keep only md, json, txt, etc if they were in the previous manifest? Wait, let's just index md and json for now, maybe py and js.
      if (
        ['.md', '.json', '.txt', '.csv', '.yml', '.yaml', '.js', '.ts', '.py', '.sh'].includes(ext)
      ) {
        files.push(path.relative(baseDir, fullPath).replace(/\\/g, '/'));
      }
    }
  }
  return files;
}

function withKnowledgeAccess<T>(operation: () => T): T {
  // Index generation is a governance tool that must see every tier and write
  // the tier-root index files. The security policy grants KNOWLEDGE_WRITE to
  // ecosystem_architect; mission_controller and knowledge_steward do not own
  // the committed product knowledge root.
  return withExecutionContext('ecosystem_architect', operation, 'ecosystem_architect');
}

function renderKnowledgeIndexFiles(): GeneratedFile[] {
  const kbRoot = pathResolver.knowledge('');
  const allFiles = walk(kbRoot, kbRoot);
  const exclusionFailures = validateFrontmatterExclusions(allFiles);
  if (exclusionFailures.length > 0) {
    throw new Error(
      exclusionFailures.map((failure) => `[generate_knowledge_index] ${failure}`).join('\n')
    );
  }

  const manifestEntries: ManifestEntry[] = [];
  const indexEntries: IndexEntry[] = [];

  // Auto-generated files that churn at runtime (hint distillation) would make
  // the committed manifest permanently stale — list them, but pin size to 0
  // so their updates never invalidate the index (check:catalogs stability).
  const VOLATILE_KNOWLEDGE_PATHS = new Set(['product/governance/HINTS.md']);

  for (const file of allFiles) {
    if (file === '_index.md' || file === '_integrity-manifest.json') continue;
    const fullPath = path.join(kbRoot, file);
    const stat = trySafeStat(fullPath);
    if (!stat) continue;
    const tier = getTier(file);
    const ext = path.extname(file).replace('.', '');

    manifestEntries.push({
      path: file,
      tier,
      size: VOLATILE_KNOWLEDGE_PATHS.has(file) ? 0 : stat.size,
      type: ext || 'unknown',
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
        tier,
      });
    }
  }

  // Codepoint comparison on purpose: localeCompare collation differs between
  // ICU builds (macOS vs Linux CI), making the generated index non-reproducible.
  manifestEntries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const manifestData = {
    files: manifestEntries,
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
  md += `*SSoT Index Version: 2.0.0 | Generated snapshot*\n\n`;
  md += `> **Volatile / Working-Memory faces** (session, mission, project, personal, daily, weekly) are **not listed here** — they are ephemeral and not SSoT. See the generated volatile index: [\`active/INDEX.volatile.md\`](../active/INDEX.volatile.md) (non-SSoT, refreshed by \`pnpm pipeline --input pipelines/volatile-index.json\`). Schema: \`knowledge/product/schemas/volatile-knowledge.schema.json\`.\n\n`;

  for (const dir of dirs) {
    md += `## 📁 ${dir}\n`;
    grouped[dir].sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
    for (const entry of grouped[dir]) {
      md += `- [${entry.title}](${entry.path}) (${entry.tier} | ${entry.author})\n`;
    }
    md += `\n`;
  }
  const indexContent = md.trim() + '\n';

  return [
    { path: KNOWLEDGE_MANIFEST_PATH, content: manifestContent },
    { path: KNOWLEDGE_INDEX_PATH, content: indexContent },
  ];
}

function normalizeManifest(content: string): string {
  try {
    const parsed = JSON.parse(content) as { files?: unknown[] };
    return JSON.stringify(parsed.files || []);
  } catch {
    return content.replace(/"generated": ".*?",\n/g, '');
  }
}

function normalizeIndex(content: string): string {
  return content
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0 && !line.startsWith('*SSoT Index Version:'))
    .join('\n');
}

function generatedFilesAreCurrent(files: readonly GeneratedFile[]): boolean {
  const expected = new Map(files.map((file) => [file.path, file.content]));
  const existingManifest = safeReadFile(KNOWLEDGE_MANIFEST_PATH, {
    encoding: 'utf8',
  }) as string;
  const existingIndex = safeReadFile(KNOWLEDGE_INDEX_PATH, {
    encoding: 'utf8',
  }) as string;
  const expectedManifest = expected.get(KNOWLEDGE_MANIFEST_PATH);
  const expectedIndex = expected.get(KNOWLEDGE_INDEX_PATH);
  return (
    expectedManifest !== undefined &&
    expectedIndex !== undefined &&
    normalizeManifest(existingManifest) === normalizeManifest(expectedManifest) &&
    normalizeIndex(existingIndex) === normalizeIndex(expectedIndex)
  );
}

export function generateIndex(checkOnly = false): boolean {
  try {
    return withKnowledgeAccess(() => {
      const files = renderKnowledgeIndexFiles();
      if (checkOnly) return generatedFilesAreCurrent(files);
      for (const file of files) safeWriteFile(file.path, file.content);
      return true;
    });
  } catch (error: unknown) {
    console.error(
      `[generate_knowledge_index] ${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  }
}

export const runGenerateKnowledgeIndex = defineGenerator({
  id: 'knowledge-index',
  outputs: [KNOWLEDGE_MANIFEST_PATH, KNOWLEDGE_INDEX_PATH],
  executionContext: 'ecosystem_architect',
  render: () => withKnowledgeAccess(() => renderKnowledgeIndexFiles()),
});

if (
  isDirectScript(import.meta.url, 'generate_knowledge_index.ts') ||
  isDirectScript(import.meta.url, 'generate_knowledge_index.js')
)
  void runGenerateKnowledgeIndex();
