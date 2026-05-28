/**
 * Distill Knowledge Injector (E5).
 *
 * Surfaces prior `mission_controller distill` outputs as additional
 * context to new decision-support / hypothesis-tree runs.
 *
 * The `distill` command produces YAML-frontmatter + markdown files in
 * `knowledge/public/evolution/distill_<mission-id>_<date>.md`. Legacy
 * mission distills may still exist under `knowledge/incidents/`; those are
 * treated as read-only compatibility inputs.
 *
 * Each frontmatter
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
import {
  getEmbeddingBackend,
  cosineSimilarity,
  reciprocalRankFusion,
} from './embedding-backend.js';

const CURRENT_DISTILL_DIR = 'knowledge/public/evolution';
const LEGACY_DISTILL_DIRS = ['knowledge/incidents', 'knowledge/evolution'];
const DISTILL_FILE_RE = /^distill_.+\.md$/;

export interface DistilledKnowledgeEntry {
  /** Relative path from project root, e.g. knowledge/public/evolution/distill_msn-foo_2026-04-27.md */
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
  const out: DistilledKnowledgeEntry[] = [];
  const seenNames = new Set<string>();
  for (const dirName of [CURRENT_DISTILL_DIR, ...LEGACY_DISTILL_DIRS]) {
    const dir = pathResolver.rootResolve(dirName);
    if (!safeExistsSync(dir)) continue;
    let entries: string[] = [];
    try {
      entries = safeReaddir(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (seenNames.has(name) || !DISTILL_FILE_RE.test(name)) continue;
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
        path: `${dirName}/${name}`,
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
      seenNames.add(name);
    }
  }
  return out;
}

// ── Embedding helpers ────────────────────────────────────────────────────────

// In-process embedding cache: path/key → vector.
// Small corpus (O(10s) of distill files) — no eviction needed.
const _embedCache = new Map<string, Float32Array>();

function _corpusText(entry: DistilledKnowledgeEntry): string {
  return [entry.title, ...entry.tags, entry.excerpt.slice(0, 300)].filter(Boolean).join(' ');
}

async function _embedWithCache(key: string, text: string): Promise<Float32Array | null> {
  if (_embedCache.has(key)) return _embedCache.get(key)!;
  const backend = getEmbeddingBackend();
  if (!backend) return null;
  try {
    const vec = await backend.embed(text);
    _embedCache.set(key, vec);
    return vec;
  } catch {
    return null;
  }
}

// ── Lexical scoring ──────────────────────────────────────────────────────────

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
 *
 * When an EmbeddingBackend is registered, uses Reciprocal Rank Fusion to
 * combine lexical scoring (tag + title overlap) with semantic cosine
 * similarity, enabling cross-lingual and conceptual matching.
 *
 * Falls back to lexical-only when no embedding backend is available.
 *
 * Returns an array sorted by score descending; entries below `minScore`
 * are dropped.
 */
export async function findRelevantDistilledKnowledge(
  input: FindRelevantInput,
): Promise<DistilledKnowledgeEntry[]> {
  const limit = input.limit ?? 5;
  const minScore = input.minScore ?? 0.0001;
  const queryTokens = new Set(tokenize(input.topic ?? ''));
  const queryTags = new Set((input.tags ?? []).map((t) => t.toLowerCase()));

  if (queryTokens.size === 0 && queryTags.size === 0) return [];

  const all = loadAllDistilled();

  // ── Lexical ranking ─────────────────────────────────────────────────────
  const lexicalScored = all
    .map((e) => ({ ...e, score: scoreEntry(e, queryTokens, queryTags) }))
    .filter((e) => (e.score ?? 0) >= minScore)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  const backend = getEmbeddingBackend();
  if (!backend) {
    // Lexical-only fallback (same as before)
    return lexicalScored
      .sort((a, b) => {
        if ((b.score ?? 0) !== (a.score ?? 0)) return (b.score ?? 0) - (a.score ?? 0);
        return (b.last_updated ?? '').localeCompare(a.last_updated ?? '');
      })
      .slice(0, limit);
  }

  // ── Semantic ranking (hybrid path) ──────────────────────────────────────
  const queryText = [input.topic, ...(input.tags ?? [])].filter(Boolean).join(' ');
  const queryVec = await _embedWithCache(`__q__${queryText}`, queryText);

  if (!queryVec) {
    // Backend present but embed failed — fall back to lexical
    return lexicalScored.slice(0, limit);
  }

  // Embed corpus entries in batch for efficiency
  const unembed = all.filter((e) => !_embedCache.has(e.path));
  if (unembed.length > 0) {
    try {
      const vectors = await backend.embedBatch(unembed.map(_corpusText));
      unembed.forEach((e, i) => _embedCache.set(e.path, vectors[i]));
    } catch {
      // If batch fails, individual entries will miss and fall through
    }
  }

  const semanticScored = all
    .map((e) => {
      const vec = _embedCache.get(e.path);
      return { entry: e, sim: vec ? cosineSimilarity(queryVec, vec) : 0 };
    })
    .filter((x) => x.sim > 0)
    .sort((a, b) => b.sim - a.sim)
    .map((x) => x.entry);

  // ── RRF fusion ──────────────────────────────────────────────────────────
  const rrfScores = reciprocalRankFusion([lexicalScored, semanticScored]);

  return all
    .map((e) => ({ ...e, score: rrfScores.get(e.path) ?? 0 }))
    .filter((e) => (e.score ?? 0) > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (b.last_updated ?? '').localeCompare(a.last_updated ?? '');
    })
    .slice(0, limit);
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
