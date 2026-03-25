import * as path from 'node:path';
import * as pathResolver from '../path-resolver.js';
import { safeExistsSync, safeReadFile, safeReaddir } from '../secure-io.js';

/**
 * Reactive Knowledge Index v1.0
 *
 * Provides a lightweight in-memory index of knowledge hints that actuators
 * can query at execution time. Built from structured JSON hint files and
 * markdown procedure titles.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface KnowledgeHint {
  topic: string;
  hint: string;
  source: string;       // file path relative to knowledge/
  confidence: number;   // 0-1
  tags?: string[];
}

export interface KnowledgeQueryOptions {
  actuator?: string;    // filter by actuator relevance
  op?: string;          // filter by operation
  maxResults?: number;  // default 5
}

// ─── Index Class ─────────────────────────────────────────────────────────────

export class KnowledgeHintIndex {
  readonly hints: KnowledgeHint[];
  readonly builtAt: string;

  constructor(hints: KnowledgeHint[]) {
    this.hints = hints;
    this.builtAt = new Date().toISOString();
  }
}

// ─── Build Index ─────────────────────────────────────────────────────────────

/**
 * Build an in-memory index of knowledge hints from:
 * 1. knowledge/public/procedures/hints/*.json (structured hints)
 * 2. Frontmatter/titles from knowledge/public/procedures/**\/*.md
 */
export async function buildKnowledgeIndex(rootDir?: string): Promise<KnowledgeHintIndex> {
  const knowledgeBase = rootDir || pathResolver.knowledge();
  const hints: KnowledgeHint[] = [];

  // 1. Load structured JSON hint files
  const hintsDir = path.join(knowledgeBase, 'public/procedures/hints');
  if (safeExistsSync(hintsDir)) {
    const files = safeReaddir(hintsDir);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const filePath = path.join(hintsDir, file);
      try {
        const content = safeReadFile(filePath, { encoding: 'utf8' }) as string;
        const parsed = JSON.parse(content);
        const entries: any[] = Array.isArray(parsed) ? parsed : [parsed];
        const relSource = path.relative(knowledgeBase, filePath);
        for (const entry of entries) {
          if (entry.topic && entry.hint) {
            hints.push({
              topic: entry.topic,
              hint: entry.hint,
              source: relSource,
              confidence: typeof entry.confidence === 'number' ? entry.confidence : 0.5,
              tags: Array.isArray(entry.tags) ? entry.tags : undefined,
            });
          }
        }
      } catch (_) {
        // Skip malformed files silently
      }
    }
  }

  // 2. Extract titles from markdown procedure files
  const proceduresDir = path.join(knowledgeBase, 'public/procedures');
  if (safeExistsSync(proceduresDir)) {
    scanMarkdownHints(proceduresDir, knowledgeBase, hints);
  }

  return new KnowledgeHintIndex(hints);
}

/**
 * Recursively scan a directory for .md files and extract title-based hints.
 */
function scanMarkdownHints(dir: string, knowledgeBase: string, hints: KnowledgeHint[]): void {
  let entries: string[];
  try {
    entries = safeReaddir(dir);
  } catch (_) {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry);

    // Skip the hints directory (already processed as JSON)
    if (entry === 'hints') continue;

    if (entry.endsWith('.md')) {
      try {
        const content = safeReadFile(fullPath, { encoding: 'utf8' }) as string;
        const title = extractMarkdownTitle(content, entry);
        if (title) {
          const relSource = path.relative(knowledgeBase, fullPath);
          const tags = extractFrontmatterTags(content);
          hints.push({
            topic: title,
            hint: `Procedure document: ${title}. See ${relSource} for details.`,
            source: relSource,
            confidence: 0.6,
            tags,
          });
        }
      } catch (_) {
        // Skip unreadable files
      }
    } else if (!entry.startsWith('.') && !entry.includes('.')) {
      // Likely a subdirectory — recurse
      if (safeExistsSync(fullPath)) {
        try {
          // Check if it's a directory by trying to readdir
          safeReaddir(fullPath);
          scanMarkdownHints(fullPath, knowledgeBase, hints);
        } catch (_) {
          // Not a directory, skip
        }
      }
    }
  }
}

/**
 * Extract the first heading or frontmatter title from a markdown file.
 */
function extractMarkdownTitle(content: string, filename: string): string {
  // Try frontmatter title
  const fmMatch = content.match(/^---\n[\s\S]*?title:\s*["']?(.+?)["']?\s*\n[\s\S]*?---/m);
  if (fmMatch) return fmMatch[1].trim();

  // Try first H1
  const h1Match = content.match(/^#\s+(.+)$/m);
  if (h1Match) return h1Match[1].trim();

  // Fallback to filename
  return filename.replace(/\.md$/, '').replace(/[-_]/g, ' ');
}

/**
 * Extract tags from YAML frontmatter.
 */
function extractFrontmatterTags(content: string): string[] | undefined {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/m);
  if (!fmMatch) return undefined;

  const tagsMatch = fmMatch[1].match(/tags:\s*\[([^\]]*)\]/);
  if (tagsMatch) {
    return tagsMatch[1].split(',').map(t => t.trim().replace(/["']/g, '')).filter(Boolean);
  }

  // YAML list style tags
  const listTagsMatch = fmMatch[1].match(/tags:\s*\n((?:\s*-\s*.+\n?)*)/);
  if (listTagsMatch) {
    return listTagsMatch[1]
      .split('\n')
      .map(line => line.replace(/^\s*-\s*/, '').trim())
      .filter(Boolean);
  }

  return undefined;
}

// ─── Query ───────────────────────────────────────────────────────────────────

/**
 * Query the knowledge index for relevant hints.
 * Uses keyword matching: splits the topic into words, scores each hint by
 * how many topic words appear in hint.topic + hint.tags + hint.hint.
 * Results are sorted by score * confidence.
 */
export function queryKnowledge(
  index: KnowledgeHintIndex,
  topic: string,
  options: KnowledgeQueryOptions = {},
): KnowledgeHint[] {
  const maxResults = options.maxResults ?? 5;
  const queryWords = topic.toLowerCase().split(/\s+/).filter(w => w.length > 1);

  if (queryWords.length === 0) return [];

  const scored: Array<{ hint: KnowledgeHint; score: number }> = [];

  for (const hint of index.hints) {
    // Filter by actuator if specified
    if (options.actuator && hint.tags) {
      const hasActuatorTag = hint.tags.some(t => t.toLowerCase() === options.actuator!.toLowerCase());
      if (!hasActuatorTag) continue;
    }

    // Filter by op if specified
    if (options.op && hint.tags) {
      const hasOpTag = hint.tags.some(t => t.toLowerCase() === options.op!.toLowerCase());
      if (!hasOpTag) continue;
    }

    // Score by keyword matching
    const searchable = [
      hint.topic.toLowerCase(),
      (hint.tags || []).join(' ').toLowerCase(),
      hint.hint.toLowerCase(),
    ].join(' ');

    let matchCount = 0;
    for (const word of queryWords) {
      if (searchable.includes(word)) {
        matchCount++;
      }
    }

    if (matchCount > 0) {
      const normalizedScore = matchCount / queryWords.length;
      scored.push({ hint, score: normalizedScore * hint.confidence });
    }
  }

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, maxResults).map(s => s.hint);
}
