/**
 * Distill Knowledge Injector (E5).
 *
 * Surfaces prior `mission_controller distill` outputs as additional
 * context to new decision-support / hypothesis-tree runs.
 *
 * The `distill` command produces YAML-frontmatter + markdown files in
 * `knowledge/incidents/distill_<mission-id>_<date>.md`. Each frontmatter
 * block carries `tags`, `category`, `source_mission`, and `importance`.
 *
 * This module loads the catalog of distillations on demand and returns
 * the top-N most relevant entries for a given topic + tag set. The
 * matching is intentionally simple (overlap of tags + keyword match in
 * title) — semantic search via embeddings is a Phase-2 upgrade.
 *
 * Used by:
 *   - `wisdom:inject_prior_knowledge` pipeline op (called early in
 *     hypothesis-tree.json so personas have access to the corpus)
 *   - `mission_controller create` (informational logging only)
 *
 * Output is read-only: this module never writes to `knowledge/`.
 */

import * as path from 'node:path';
import * as pathResolver from './path-resolver.js';
import {
  safeReadFile,
  safeReaddir,
  safeExistsSync,
} from './secure-io.js';

const INCIDENTS_DIR = 'knowledge/incidents';
const DISTILL_FILE_RE = /^distill_.+\.md$/;

export interface DistilledKnowledgeEntry {
  /** Relative path from project root, e.g. knowledge/incidents/distill_msn-foo_2026-04-27.md */
  path: string;
  /** Frontmatter `title` */
  title: string;
  /** Frontmatter `category` (optional) */
  category?: string;
  /** Frontmatter `tags` (parsed from `[a, b]` form) */
  tags: string[];
  /** Frontmatter `source_mission` */
  source_mission?: string;
  /** Frontmatter `importance` (numeric, optional) */
  importance?: number;
  /** Frontmatter `last_updated` or `audit_date` */
  last_updated?: string;
  /**
   * First non-frontmatter paragraph of the file (≤ 400 chars). Used as
   * a brief excerpt for context injection without loading the whole body.
   */
  excerpt: string;
  /** Match score for the active query (set by findRelevant…). */
  score?: number;
}

export interface FindRelevantInput {
  /** Free-text topic to match against title and tags. */
  topic: string;
  /** Explicit tag list. Tag overlap dominates score. */
  tags?: string[];
  /** Maximum entries returned (sorted by score desc). Defaults to 5. */
  limit?: number;
  /**
   * Optional minimum score threshold (0–1 normalized to ~0.05 step).
   * Defaults to 0 (return any non-zero match).
   */
  minScore?: number;
}

function parseFrontmatter(text: string): Record<string, unknown> {
  if (!text.startsWith('---\n')) return {};
  const end = text.indexOf('\n---\n', 4);
  if (end === -1) return {};
  const block = text.slice(4, end);
  const out: Record<string, unknown> = {};
  for (const rawLine of block.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let value: unknown = m[2];
    const v = (value as string).trim();
    if (v.startsWith('[') && v.endsWith(']')) {
      value = v
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    } else if (/^\d+$/.test(v)) {
      value = Number(v);
    } else if (v.startsWith('"') && v.endsWith('"')) {
      value = v.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function firstParagraph(body: string, max = 400): string {
  const trimmed = body.trim();
  const idx = trimmed.indexOf('\n\n');
  const para = idx >= 0 ? trimmed.slice(0, idx) : trimmed;
  return para.replace(/\s+/g, ' ').slice(0, max);
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\u3000-\u9fff\s_-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

function loadAllDistilled(): DistilledKnowledgeEntry[] {
  const dir = pathResolver.rootResolve(INCIDENTS_DIR);
  if (!safeExistsSync(dir)) return [];
  const out: DistilledKnowledgeEntry[] = [];
  let entries: string[] = [];
  try {
    entries = safeReaddir(dir);
  } catch {
    return [];
  }
  for (const name of entries) {
    if (!DISTILL_FILE_RE.test(name)) continue;
    const abs = path.join(dir, name);
    let text: string;
    try {
      text = safeReadFile(abs, { encoding: 'utf8' }) as string;
    } catch {
      continue;
    }
    const fm = parseFrontmatter(text);
    const bodyStart = text.indexOf('\n---\n', 4);
    const body = bodyStart >= 0 ? text.slice(bodyStart + 5) : text;
    const tags = Array.isArray(fm.tags) ? (fm.tags as string[]) : [];
    out.push({
      path: `${INCIDENTS_DIR}/${name}`,
      title: typeof fm.title === 'string' ? fm.title : name,
      ...(typeof fm.category === 'string' ? { category: fm.category } : {}),
      tags,
      ...(typeof fm.source_mission === 'string'
        ? { source_mission: fm.source_mission }
        : {}),
      ...(typeof fm.importance === 'number' ? { importance: fm.importance } : {}),
      ...(typeof fm.last_updated === 'string'
        ? { last_updated: fm.last_updated }
        : typeof fm.audit_date === 'string'
          ? { last_updated: fm.audit_date }
          : {}),
      excerpt: firstParagraph(body),
    });
  }
  return out;
}

/**
 * Score a single entry against a query.
 *
 * Score = 0.7 × (tag overlap ratio) + 0.3 × (token overlap ratio in title).
 * Tie-broken by importance and recency.
 */
function scoreEntry(
  entry: DistilledKnowledgeEntry,
  queryTokens: Set<string>,
  queryTags: Set<string>,
): number {
  const titleTokens = new Set(tokenize(entry.title));
  const titleOverlap =
    queryTokens.size === 0
      ? 0
      : [...queryTokens].filter((t) => titleTokens.has(t)).length /
        queryTokens.size;
  const tagOverlap =
    queryTags.size === 0
      ? 0
      : entry.tags.filter((t) => queryTags.has(t.toLowerCase())).length /
        Math.max(queryTags.size, 1);
  const base = 0.7 * tagOverlap + 0.3 * titleOverlap;
  // Importance bonus (0..0.05 per importance point above 5)
  const importanceBonus = entry.importance && entry.importance > 5
    ? Math.min(0.1, (entry.importance - 5) * 0.02)
    : 0;
  return base + importanceBonus;
}

/**
 * Find the top-N distilled-knowledge entries relevant to the query.
 * Returns an array sorted by score descending; entries below `minScore`
 * are dropped.
 */
export function findRelevantDistilledKnowledge(
  input: FindRelevantInput,
): DistilledKnowledgeEntry[] {
  const limit = input.limit ?? 5;
  const minScore = input.minScore ?? 0.0001;
  const queryTokens = new Set(tokenize(input.topic ?? ''));
  const queryTags = new Set((input.tags ?? []).map((t) => t.toLowerCase()));

  if (queryTokens.size === 0 && queryTags.size === 0) return [];

  const all = loadAllDistilled();
  const scored = all
    .map((e) => ({ ...e, score: scoreEntry(e, queryTokens, queryTags) }))
    .filter((e) => (e.score ?? 0) >= minScore)
    .sort((a, b) => {
      if ((b.score ?? 0) !== (a.score ?? 0)) return (b.score ?? 0) - (a.score ?? 0);
      // Tie-break on recency
      return (b.last_updated ?? '').localeCompare(a.last_updated ?? '');
    });
  return scored.slice(0, limit);
}

/**
 * Render a found entry as a one-line summary suitable for prompt
 * injection or UI display.
 */
export function formatDistilledKnowledgeSummary(
  entry: DistilledKnowledgeEntry,
): string {
  const tags = entry.tags.length ? ` [${entry.tags.slice(0, 3).join(', ')}]` : '';
  const score =
    entry.score !== undefined ? ` (score=${entry.score.toFixed(2)})` : '';
  return `- ${entry.title}${tags}${score}\n  ${entry.excerpt.slice(0, 160)}…\n  source: ${entry.path}`;
}
