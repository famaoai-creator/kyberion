import * as path from 'node:path';
import { createHash } from 'node:crypto';
import * as pathResolver from '../path-resolver.js';
import {
  safeExistsSync,
  safeReadFile,
  safeReaddir,
  safeWriteFile,
  safeMkdir,
  safeStat,
  safeUnlinkSync,
} from '../secure-io.js';
import {
  getEmbeddingBackend,
  cosineSimilarity,
  reciprocalRankFusion,
} from '../embedding-backend.js';

/**
 * Reactive Knowledge Index v3.0
 *
 * v3 changes over v2:
 * - KnowledgeScope: declare which tiers/domains/tags to index per intent
 * - buildScopedIndex(): scope-keyed disk cache + multi-tier scanning
 *   (public / confidential / personal + customer overlay)
 * - Per-index embedCache (Map on KnowledgeHintIndex) — no module-level sharing
 * - buildKnowledgeIndex() remains as a backward-compat alias for public-only scope
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface KnowledgeHint {
  topic: string;
  hint: string;
  source: string;
  confidence: number;
  tags?: string[];
  tier?: 'public' | 'confidential' | 'personal' | 'product';
  customerId?: string;
  /**
   * KM-02 body-chunk provenance. Internal chunk entries carry
   * `source = "<doc>#chunkN"` plus parentSource/chunkIndex; aggregated query
   * results are rewritten back to the resolvable document path and expose
   * the winning chunk via matchedChunkIndex. All fields additive.
   */
  parentSource?: string;
  chunkIndex?: number;
  matchedChunkIndex?: number;
  /** Which embedding backend ranked this result (degraded-mode visibility). */
  embeddingBackend?: string;
}

export interface KnowledgeQueryOptions {
  actuator?: string;
  op?: string;
  maxResults?: number;
}

/**
 * Declares the knowledge space a pipeline/intent is allowed to access.
 *
 * The scope hash becomes the disk-cache key:
 *   active/shared/cache/ki-{scopeHash}.json
 *
 * Same scope across missions → shared cached vectors.
 * Different tiers/customer → different file → isolation guaranteed.
 */
export interface KnowledgeScope {
  /** Which tiers to scan. Order is irrelevant; results are merged. */
  tiers: Array<'public' | 'confidential' | 'personal' | 'product'>;
  /**
   * Restrict 'confidential' scanning to one customer subdirectory.
   * Also activates customer/ overlay for 'personal' tier.
   * If omitted with tier='confidential', all subdirs are scanned.
   */
  customerId?: string;
  /**
   * Limit to these Tier-1 domain subdirectories under each tier root.
   * Defaults to TIER1_SUBDIRS (all).
   */
  domains?: string[];
  /**
   * Pre-filter: only index documents whose tags overlap this set.
   * Reduces embedding corpus for focused intents.
   */
  filterTags?: string[];
  /**
   * Embedding model name — included in the cache key so that switching
   * models automatically invalidates cached vectors.
   */
  embeddingModel?: string;
}

export const DEFAULT_SCOPE: KnowledgeScope = { tiers: ['public'] };

// ─── Index class ─────────────────────────────────────────────────────────────

export class KnowledgeHintIndex {
  readonly hints: KnowledgeHint[];
  readonly builtAt: string;
  readonly scope?: KnowledgeScope;
  /** Per-instance embedding cache. Isolated per scope — no cross-tier leakage. */
  readonly embedCache: Map<string, Float32Array>;

  constructor(hints: KnowledgeHint[], scope?: KnowledgeScope) {
    this.hints = hints;
    this.builtAt = new Date().toISOString();
    this.scope = scope;
    this.embedCache = new Map();
  }
}

// ─── Module-level cache (legacy — kept for clearKnowledgeEmbedCache compat) ──
const _embedCache = new Map<string, Float32Array>();

export function clearKnowledgeEmbedCache(): void {
  _embedCache.clear();
}

// ─── Disk-cache helpers ───────────────────────────────────────────────────────

interface DiskCacheEntry {
  source: string;
  textHash: string;
  vector: number[];
}

interface DiskCache {
  scopeHash: string;
  model: string;
  builtAt: string;
  entries: DiskCacheEntry[];
}

export function computeScopeHash(scope: KnowledgeScope, modelName?: string): string {
  const key = JSON.stringify({
    tiers: [...scope.tiers].sort(),
    customerId: scope.customerId ?? null,
    domains: scope.domains ? [...scope.domains].sort() : null,
    filterTags: scope.filterTags ? [...scope.filterTags].sort() : null,
    model: scope.embeddingModel ?? modelName ?? 'default',
  });
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

function computeTextHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

function cacheDir(): string {
  const override = process.env.KYBERION_KI_CACHE_DIR?.trim();
  if (override) return override;
  const root = path.dirname(pathResolver.knowledge());
  return path.join(root, 'active', 'shared', 'cache');
}

function cacheFilePath(scopeHash: string): string {
  return path.join(cacheDir(), `ki-${scopeHash}.json`);
}

// ─── Cache budget (KM-02 Task 1.2: LRU eviction) ─────────────────────────────
//
// ki-*.json files accumulate as scopes and embedding models change (every
// model switch mints a new scope hash and orphans the old file). A sidecar
// usage map records last-use per scope so eviction tracks reads, not just
// writes; files without a usage entry fall back to mtime.

const USAGE_FILE = 'ki-usage.json';
const DEFAULT_CACHE_BUDGET_MB = 200;
const KI_FILE_PATTERN = /^ki-[0-9a-f]{16}\.json$/;

function usageFilePath(): string {
  return path.join(cacheDir(), USAGE_FILE);
}

function loadUsageMap(): Record<string, string> {
  try {
    if (!safeExistsSync(usageFilePath())) return {};
    const parsed = JSON.parse(safeReadFile(usageFilePath(), { encoding: 'utf8' }) as string);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    /* corrupt usage map: rebuild from scratch */
    return {};
  }
}

function touchScopeUsage(scopeHash: string): void {
  try {
    const usage = loadUsageMap();
    usage[scopeHash] = new Date().toISOString();
    const dir = cacheDir();
    if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
    safeWriteFile(usageFilePath(), JSON.stringify(usage));
  } catch {
    /* usage tracking is best-effort; eviction falls back to mtime */
  }
}

function resolveCacheBudgetBytes(): number {
  const raw = Number(process.env.KYBERION_KI_CACHE_MAX_MB || '');
  const mb = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CACHE_BUDGET_MB;
  return mb * 1024 * 1024;
}

/**
 * Delete least-recently-used ki-*.json cache files until the cache directory
 * fits the budget (KYBERION_KI_CACHE_MAX_MB, default 200MB). Exported for
 * tests and operational use.
 */
export function enforceKnowledgeCacheBudget(): void {
  try {
    const dir = cacheDir();
    if (!safeExistsSync(dir)) return;
    const files = (safeReaddir(dir) as string[]).filter((f) => KI_FILE_PATTERN.test(f));
    const usage = loadUsageMap();
    const stats = files.map((f) => {
      const full = path.join(dir, f);
      const st = safeStat(full);
      const scopeHash = f.slice(3, 19);
      const lastUsed = usage[scopeHash] ? Date.parse(usage[scopeHash]) : st.mtimeMs;
      return { full, scopeHash, size: st.size, lastUsed };
    });
    let total = stats.reduce((sum, s) => sum + s.size, 0);
    const budget = resolveCacheBudgetBytes();
    if (total <= budget) return;

    stats.sort((a, b) => a.lastUsed - b.lastUsed);
    const evictedScopes: string[] = [];
    for (const s of stats) {
      if (total <= budget) break;
      safeUnlinkSync(s.full);
      total -= s.size;
      evictedScopes.push(s.scopeHash);
    }
    if (evictedScopes.length > 0) {
      for (const scope of evictedScopes) delete usage[scope];
      safeWriteFile(usageFilePath(), JSON.stringify(usage));
    }
  } catch {
    /* eviction is best-effort; an oversized cache is not fatal */
  }
}

function loadDiskCache(scopeHash: string): Map<string, { textHash: string; vector: Float32Array }> {
  const result = new Map<string, { textHash: string; vector: Float32Array }>();
  const filePath = cacheFilePath(scopeHash);
  if (!safeExistsSync(filePath)) return result;
  try {
    const raw = safeReadFile(filePath, { encoding: 'utf8' }) as string;
    const cache: DiskCache = JSON.parse(raw);
    for (const entry of cache.entries) {
      result.set(entry.source, {
        textHash: entry.textHash,
        vector: new Float32Array(entry.vector),
      });
    }
    touchScopeUsage(scopeHash);
  } catch {
    // Corrupt or unreadable cache — ignore, will rebuild
  }
  return result;
}

function saveDiskCache(scopeHash: string, modelName: string, entries: DiskCacheEntry[]): void {
  const filePath = cacheFilePath(scopeHash);
  try {
    const dir = path.dirname(filePath);
    if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
    const cache: DiskCache = {
      scopeHash,
      model: modelName,
      builtAt: new Date().toISOString(),
      entries,
    };
    safeWriteFile(filePath, JSON.stringify(cache));
    touchScopeUsage(scopeHash);
    enforceKnowledgeCacheBudget();
  } catch {
    // Cache write failure is non-fatal
  }
}

// ─── Tier-1 subdirectories (public default) ───────────────────────────────────

const TIER1_SUBDIRS = [
  'procedures',
  'architecture',
  'design-patterns',
  'external-wisdom',
  'nonfunctional',
  'organization',
];

// ─── Scope-aware index builder ────────────────────────────────────────────────

/**
 * Build an in-memory knowledge index for the given scope.
 *
 * 1. Scans the declared tier directories for hints (fast, always runs).
 * 2. Loads matching vectors from the scope-keyed disk cache.
 * 3. If an EmbeddingBackend is available, eagerly embeds uncached hints
 *    and writes the updated cache back to disk.
 *
 * Isolation: each (tiers × customerId × domains × model) combination maps to
 * a distinct cache file, so confidential vectors never share storage with
 * public-only indexes.
 */
export async function buildScopedIndex(
  scope: KnowledgeScope = DEFAULT_SCOPE,
  rootDir?: string
): Promise<KnowledgeHintIndex> {
  const knowledgeBase = rootDir || pathResolver.knowledge();
  const hints: KnowledgeHint[] = [];

  const domains = scope.domains ?? TIER1_SUBDIRS;

  for (const tier of scope.tiers) {
    switch (tier) {
      case 'public':
        _scanPublicTier(knowledgeBase, domains, hints);
        break;
      case 'product':
        _scanProductTier(knowledgeBase, domains, hints);
        break;
      case 'confidential':
        _scanConfidentialTier(knowledgeBase, domains, scope.customerId, hints);
        break;
      case 'personal':
        _scanPersonalTier(knowledgeBase, domains, scope.customerId, hints);
        break;
    }
  }

  // Apply tag pre-filter after scanning (cheaper than per-file filter)
  const filteredHints = scope.filterTags?.length
    ? hints.filter((h) => h.tags?.some((t) => scope.filterTags!.includes(t)))
    : hints;

  const index = new KnowledgeHintIndex(filteredHints, scope);

  await _hydrateEmbedCache(index, scope);

  return index;
}

/**
 * Backward-compat alias — builds a public-only index (v2 behaviour).
 * Passes rootDir through for test injection.
 */
export async function buildKnowledgeIndex(rootDir?: string): Promise<KnowledgeHintIndex> {
  return buildScopedIndex(DEFAULT_SCOPE, rootDir);
}

// ─── Embedding cache hydration ────────────────────────────────────────────────

async function _hydrateEmbedCache(index: KnowledgeHintIndex, scope: KnowledgeScope): Promise<void> {
  const backend = getEmbeddingBackend();
  const modelName = backend?.name ?? 'none';
  const scopeHash = computeScopeHash(scope, modelName);

  const diskCache = loadDiskCache(scopeHash);

  const toEmbed: KnowledgeHint[] = [];
  const upToDate: DiskCacheEntry[] = [];

  for (const hint of index.hints) {
    const text = _corpusText(hint);
    const textHash = computeTextHash(text);
    const cached = diskCache.get(hint.source);

    if (cached && cached.textHash === textHash) {
      index.embedCache.set(hint.source, cached.vector);
      upToDate.push({ source: hint.source, textHash, vector: Array.from(cached.vector) });
    } else {
      toEmbed.push(hint);
    }
  }

  if (toEmbed.length === 0 || !backend) return;

  try {
    const vectors = await backend.embedBatch(toEmbed.map(_corpusText));
    const newEntries: DiskCacheEntry[] = [];
    toEmbed.forEach((hint, i) => {
      index.embedCache.set(hint.source, vectors[i]);
      newEntries.push({
        source: hint.source,
        textHash: computeTextHash(_corpusText(hint)),
        vector: Array.from(vectors[i]),
      });
    });

    // Persist merged cache (up-to-date + newly embedded)
    saveDiskCache(scopeHash, modelName, [...upToDate, ...newEntries]);
  } catch {
    // Silent — index still usable for lexical search
  }
}

// ─── Tier scanners ────────────────────────────────────────────────────────────

function _scanPublicTier(knowledgeBase: string, domains: string[], hints: KnowledgeHint[]): void {
  // Structured JSON hints
  const hintsDir = path.join(knowledgeBase, 'public/procedures/hints');
  if (safeExistsSync(hintsDir)) {
    _loadJsonHints(hintsDir, knowledgeBase, 'public', undefined, hints);
  }

  // Markdown hints across Tier-1 domains
  for (const domain of domains) {
    const dir = path.join(knowledgeBase, 'public', domain);
    if (safeExistsSync(dir)) {
      _scanMarkdownHints(dir, knowledgeBase, 'public', undefined, hints);
    }
  }
}

function _scanProductTier(knowledgeBase: string, domains: string[], hints: KnowledgeHint[]): void {
  const productRoot = path.join(knowledgeBase, 'product');
  if (!safeExistsSync(productRoot)) return;

  // Structured JSON hints under product/hints if present
  const hintsDir = path.join(productRoot, 'hints');
  if (safeExistsSync(hintsDir)) {
    _loadJsonHints(hintsDir, knowledgeBase, 'product', undefined, hints);
  }

  // Closes the ④→① arc of the intent loop: hints auto-extracted from execution
  // traces (persisted by runFeedbackLoop → libs/core/src/feedback-loop.ts) are
  // ingested here so trace-derived lessons re-enter resolution / mission context
  // via queryKnowledge. Without this the feedback loop only ever writes, never
  // reads back (the "溜まるだけで参照されない" failure the concept warns of).
  const feedbackHintsDir = pathResolver.shared('runtime/feedback-loop/hints');
  if (safeExistsSync(feedbackHintsDir)) {
    _loadJsonHints(feedbackHintsDir, knowledgeBase, 'product', undefined, hints);
  }

  // Scan declared domains; fall back to full product root when using TIER1_SUBDIRS default
  if (domains !== TIER1_SUBDIRS) {
    for (const domain of domains) {
      const dir = path.join(productRoot, domain);
      if (safeExistsSync(dir)) {
        _scanMarkdownHints(dir, knowledgeBase, 'product', undefined, hints);
      }
    }
  } else {
    _scanMarkdownHints(productRoot, knowledgeBase, 'product', undefined, hints);
  }
}

function _scanConfidentialTier(
  knowledgeBase: string,
  domains: string[],
  customerId: string | undefined,
  hints: KnowledgeHint[]
): void {
  const confidentialRoot = path.join(knowledgeBase, 'confidential');
  if (!safeExistsSync(confidentialRoot)) return;

  let customerDirs: string[];
  if (customerId) {
    customerDirs = [customerId];
  } else {
    try {
      customerDirs = safeReaddir(confidentialRoot).filter((e) => !e.startsWith('.'));
    } catch {
      return;
    }
  }

  for (const cid of customerDirs) {
    const cidRoot = path.join(confidentialRoot, cid);
    if (!safeExistsSync(cidRoot)) continue;

    // Confidential dirs have customer-specific structures (design/, financials/,
    // browser-workflows/, etc.) that don't follow public's Tier-1 layout.
    // Always scan the full customer root; `domains` acts as an allowlist only
    // when the caller explicitly wants to narrow to Tier-1-named subdirs.
    if (domains !== TIER1_SUBDIRS) {
      // Explicit domain filter: only scan matching subdirs
      for (const domain of domains) {
        const dir = path.join(cidRoot, domain);
        if (safeExistsSync(dir)) {
          _scanMarkdownHints(dir, knowledgeBase, 'confidential', cid, hints);
        }
      }
    } else {
      // Default (no explicit filter): scan the full customer root recursively
      _scanMarkdownHints(cidRoot, knowledgeBase, 'confidential', cid, hints);
    }
  }
}

function _scanPersonalTier(
  knowledgeBase: string,
  domains: string[],
  customerId: string | undefined,
  hints: KnowledgeHint[]
): void {
  // Customer overlay: customer/{slug}/ takes precedence over knowledge/personal/
  const customerSlug = customerId ?? process.env.KYBERION_CUSTOMER?.trim() ?? '';
  const projectRoot = path.dirname(knowledgeBase);

  const roots: Array<{ dir: string; label: string }> = [];
  if (customerSlug) {
    const customerDir = path.join(projectRoot, 'customer', customerSlug);
    if (safeExistsSync(customerDir)) {
      roots.push({ dir: customerDir, label: customerSlug });
    }
  }
  const personalDir = path.join(knowledgeBase, 'personal');
  if (safeExistsSync(personalDir)) {
    roots.push({ dir: personalDir, label: 'personal' });
  }

  // Deduplicate: skip a source path that already appeared from a higher-priority root
  const seenSources = new Set<string>();

  for (const { dir } of roots) {
    const tempHints: KnowledgeHint[] = [];
    _scanMarkdownHints(dir, knowledgeBase, 'personal', customerId, tempHints);
    for (const hint of tempHints) {
      if (!seenSources.has(hint.source)) {
        seenSources.add(hint.source);
        hints.push(hint);
      }
    }
  }
}

// ─── Low-level scanners ───────────────────────────────────────────────────────

function _loadJsonHints(
  dir: string,
  knowledgeBase: string,
  tier: 'public' | 'confidential' | 'personal' | 'product',
  customerId: string | undefined,
  hints: KnowledgeHint[]
): void {
  let files: string[];
  try {
    files = safeReaddir(dir);
  } catch {
    return;
  }

  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const filePath = path.join(dir, file);
    try {
      const content = safeReadFile(filePath, { encoding: 'utf8' }) as string;
      const parsed = JSON.parse(content);
      const entries: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
      const relSource = path.relative(knowledgeBase, filePath);
      for (const entry of entries) {
        if (
          entry !== null &&
          typeof entry === 'object' &&
          'topic' in entry &&
          'hint' in entry &&
          typeof (entry as Record<string, unknown>).topic === 'string' &&
          typeof (entry as Record<string, unknown>).hint === 'string'
        ) {
          const e = entry as Record<string, unknown>;
          hints.push({
            topic: e.topic as string,
            hint: e.hint as string,
            source: relSource,
            confidence: typeof e.confidence === 'number' ? (e.confidence as number) : 0.5,
            tags: Array.isArray(e.tags) ? (e.tags as string[]) : undefined,
            tier,
            ...(customerId ? { customerId } : {}),
          });
        }
      }
    } catch {
      // Skip malformed files
    }
  }
}

function _scanMarkdownHints(
  dir: string,
  knowledgeBase: string,
  tier: 'public' | 'confidential' | 'personal' | 'product',
  customerId: string | undefined,
  hints: KnowledgeHint[]
): void {
  let entries: string[];
  try {
    entries = safeReaddir(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry);

    if (entry === 'hints') continue; // Already handled as JSON

    if (entry.endsWith('.md')) {
      try {
        const content = safeReadFile(fullPath, { encoding: 'utf8' }) as string;
        const title = _extractMarkdownTitle(content, entry);
        if (title) {
          const relSource = path.relative(knowledgeBase, fullPath);
          const tags = _extractFrontmatterTags(content);
          const excerpt = _extractFirstParagraph(content);
          hints.push({
            topic: title,
            hint: excerpt ? `${title}. ${excerpt.slice(0, 200)}` : `See ${relSource} for details.`,
            source: relSource,
            confidence: 0.6,
            tags,
            tier,
            ...(customerId ? { customerId } : {}),
          });
          // KM-02 Task 1: index the document body as chunks so terms that
          // only appear past the first paragraph become searchable.
          const chunks = _chunkMarkdownBody(content);
          chunks.forEach((chunk, index) => {
            hints.push({
              topic: title,
              hint: chunk,
              source: `${relSource}#chunk${index}`,
              parentSource: relSource,
              chunkIndex: index,
              confidence: 0.55,
              tags,
              tier,
              ...(customerId ? { customerId } : {}),
            });
          });
        }
      } catch {
        // Skip unreadable files
      }
    } else if (!entry.startsWith('.') && !entry.includes('.')) {
      // Likely a subdirectory — recurse
      if (safeExistsSync(fullPath)) {
        try {
          safeReaddir(fullPath);
          _scanMarkdownHints(fullPath, knowledgeBase, tier, customerId, hints);
        } catch {
          // Not a directory, skip
        }
      }
    }
  }
}

// ─── Markdown helpers ─────────────────────────────────────────────────────────

function _extractMarkdownTitle(content: string, filename: string): string {
  const fmMatch = content.match(/^---\n[\s\S]*?title:\s*["']?(.+?)["']?\s*\n[\s\S]*?---/m);
  if (fmMatch) return fmMatch[1].trim();
  const h1Match = content.match(/^#\s+(.+)$/m);
  if (h1Match) return h1Match[1].trim();
  return filename.replace(/\.md$/, '').replace(/[-_]/g, ' ');
}

function _extractFrontmatterTags(content: string): string[] | undefined {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/m);
  if (!fmMatch) return undefined;

  const tagsMatch = fmMatch[1].match(/tags:\s*\[([^\]]*)\]/);
  if (tagsMatch) {
    return tagsMatch[1]
      .split(',')
      .map((t) => t.trim().replace(/["']/g, ''))
      .filter(Boolean);
  }
  const listTagsMatch = fmMatch[1].match(/tags:\s*\n((?:\s*-\s*.+\n?)*)/);
  if (listTagsMatch) {
    return listTagsMatch[1]
      .split('\n')
      .map((line) => line.replace(/^\s*-\s*/, '').trim())
      .filter(Boolean);
  }
  return undefined;
}

function _extractFirstParagraph(content: string): string {
  const bodyStart = content.startsWith('---\n') ? content.indexOf('\n---\n', 4) + 5 : 0;
  const body = content.slice(bodyStart).trim();
  for (const block of body.split('\n\n')) {
    const t = block.trim();
    if (t && !t.startsWith('#') && !t.startsWith('---')) return t.replace(/\s+/g, ' ');
  }
  return '';
}

// ─── Body chunking (KM-02 Task 1) ────────────────────────────────────────────

const CHUNK_TARGET_CHARS = 1000;
const CHUNK_OVERLAP_CHARS = 100;
const CHUNK_MIN_BODY_CHARS = 600;
const CHUNK_MAX_PER_DOC = 12;

/**
 * Split a markdown body into ~800–1200 char chunks, preferring heading
 * boundaries, with a small overlap. Short bodies (already covered by the
 * first-paragraph excerpt) produce no chunks.
 */
export function _chunkMarkdownBody(content: string): string[] {
  const bodyStart = content.startsWith('---\n') ? content.indexOf('\n---\n', 4) + 5 : 0;
  const body = content.slice(bodyStart).trim();
  if (body.length < CHUNK_MIN_BODY_CHARS) return [];

  // Prefer heading boundaries; fall back to paragraph packing.
  const sections = body.split(/\n(?=#{1,6}\s)/);
  const chunks: string[] = [];
  let current = '';

  const flush = () => {
    const trimmed = current.trim();
    if (trimmed.length > 0) chunks.push(trimmed.replace(/\s+/g, ' '));
    current = '';
  };

  for (const section of sections) {
    for (const paragraph of section.split('\n\n')) {
      const piece = paragraph.trim();
      if (!piece) continue;
      if (current.length > 0 && current.length + piece.length > CHUNK_TARGET_CHARS) {
        const overlap = current.slice(-CHUNK_OVERLAP_CHARS);
        flush();
        current = `${overlap} ${piece}`;
      } else {
        current = current ? `${current}\n\n${piece}` : piece;
      }
      // Hard cap for pathological single paragraphs.
      while (current.length > CHUNK_TARGET_CHARS * 1.5 && chunks.length < CHUNK_MAX_PER_DOC) {
        const head = current.slice(0, CHUNK_TARGET_CHARS);
        const rest = current.slice(CHUNK_TARGET_CHARS - CHUNK_OVERLAP_CHARS);
        current = head;
        flush();
        current = rest;
      }
      if (chunks.length >= CHUNK_MAX_PER_DOC) return chunks.slice(0, CHUNK_MAX_PER_DOC);
    }
  }
  flush();
  return chunks.slice(0, CHUNK_MAX_PER_DOC);
}

// ─── Corpus text helper ───────────────────────────────────────────────────────

function _corpusText(hint: KnowledgeHint): string {
  // Chunk entries embed their full body slice; document entries keep the
  // original compact form so existing cache vectors stay valid.
  const bodyBudget = hint.chunkIndex !== undefined ? 1200 : 300;
  return [hint.topic, ...(hint.tags ?? []), hint.hint.slice(0, bodyBudget)]
    .filter(Boolean)
    .join(' ');
}

// ─── Document-level aggregation (KM-02 Task 1.3) ─────────────────────────────

/**
 * Collapse ranked hints to one entry per document: the best-ranked chunk (or
 * the document entry itself) wins. Chunk winners are rewritten back to the
 * resolvable document path, exposing the position via matchedChunkIndex.
 */
function _aggregateByDocument(ranked: KnowledgeHint[]): KnowledgeHint[] {
  const seen = new Set<string>();
  const out: KnowledgeHint[] = [];
  for (const hint of ranked) {
    const docKey = hint.parentSource ?? hint.source;
    if (seen.has(docKey)) continue;
    seen.add(docKey);
    if (hint.parentSource !== undefined) {
      const { parentSource: _parent, chunkIndex, ...rest } = hint;
      out.push({ ...rest, source: docKey, matchedChunkIndex: chunkIndex });
    } else {
      out.push(hint);
    }
  }
  return out;
}

// ─── Query (lexical) ─────────────────────────────────────────────────────────

export function queryKnowledge(
  index: KnowledgeHintIndex,
  topic: string,
  options: KnowledgeQueryOptions = {}
): KnowledgeHint[] {
  const maxResults = options.maxResults ?? 5;
  const queryWords = topic
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 1);

  if (queryWords.length === 0) return [];

  const scored: Array<{ hint: KnowledgeHint; score: number }> = [];

  for (const hint of _filteredHints(index, options)) {
    const searchable = [
      hint.topic.toLowerCase(),
      (hint.tags ?? []).join(' ').toLowerCase(),
      hint.hint.toLowerCase(),
    ].join(' ');

    let matchCount = 0;
    for (const word of queryWords) {
      if (searchable.includes(word)) matchCount++;
    }

    if (matchCount > 0) {
      scored.push({ hint, score: (matchCount / queryWords.length) * hint.confidence });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return _aggregateByDocument(scored.map((s) => s.hint)).slice(0, maxResults);
}

// ─── Query (hybrid — lexical + semantic via RRF) ──────────────────────────────

/**
 * Hybrid knowledge query combining lexical keyword matching with semantic
 * cosine similarity via Reciprocal Rank Fusion.
 *
 * Uses index.embedCache (per-scope, isolated). Falls back to queryKnowledge
 * when no EmbeddingBackend is registered or when embedding fails.
 *
 * buildScopedIndex() pre-populates index.embedCache from the disk cache so
 * that first-query latency is minimal even after process restart.
 */
export async function queryKnowledgeHybrid(
  index: KnowledgeHintIndex,
  topic: string,
  options: KnowledgeQueryOptions = {}
): Promise<KnowledgeHint[]> {
  const maxResults = options.maxResults ?? 5;
  const queryWords = topic
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 1);

  if (queryWords.length === 0) return [];

  const pool = _filteredHints(index, options);

  // ── Lexical ranking ─────────────────────────────────────────────────────
  const lexicalScored: Array<{ hint: KnowledgeHint; score: number }> = [];
  for (const hint of pool) {
    const searchable = [
      hint.topic.toLowerCase(),
      (hint.tags ?? []).join(' ').toLowerCase(),
      hint.hint.toLowerCase(),
    ].join(' ');
    let matchCount = 0;
    for (const word of queryWords) {
      if (searchable.includes(word)) matchCount++;
    }
    if (matchCount > 0) {
      lexicalScored.push({ hint, score: (matchCount / queryWords.length) * hint.confidence });
    }
  }
  lexicalScored.sort((a, b) => b.score - a.score);
  const lexicalRanked = lexicalScored.map((s) => s.hint);

  const backend = getEmbeddingBackend();
  if (!backend) return queryKnowledge(index, topic, options);

  // ── Semantic ranking ────────────────────────────────────────────────────
  let queryVec: Float32Array | null = null;
  try {
    queryVec = await backend.embed(topic);
  } catch {
    return queryKnowledge(index, topic, options);
  }

  // Use the per-index cache (populated by buildScopedIndex / _hydrateEmbedCache)
  const cache = index.embedCache;

  // Embed any hints not yet in the per-index cache
  const unembed = pool.filter((h) => !cache.has(h.source));
  if (unembed.length > 0) {
    try {
      const vectors = await backend.embedBatch(unembed.map(_corpusText));
      unembed.forEach((h, i) => cache.set(h.source, vectors[i]));
    } catch {
      // Remaining hints will score 0 in semantic ranking
    }
  }

  const semanticRanked = pool
    .map((h) => {
      const vec = cache.get(h.source);
      return { hint: h, sim: vec ? cosineSimilarity(queryVec!, vec) : 0 };
    })
    .filter((x) => x.sim > 0)
    .sort((a, b) => b.sim - a.sim)
    .map((x) => x.hint);

  // ── RRF fusion ──────────────────────────────────────────────────────────
  const rrfScores = reciprocalRankFusion([
    lexicalRanked.map((h) => ({ ...h, path: h.source })),
    semanticRanked.map((h) => ({ ...h, path: h.source })),
  ]);

  const fused = pool
    .filter((h) => rrfScores.has(h.source))
    .sort((a, b) => (rrfScores.get(b.source) ?? 0) - (rrfScores.get(a.source) ?? 0));

  // Degraded-mode visibility (KM-02 Task 2): callers can tell whether the
  // "semantic" leg was real (mlx) or the hash-bucket approximation.
  const results = _aggregateByDocument(fused)
    .slice(0, maxResults)
    .map((h) => ({ ...h, embeddingBackend: backend.name }));

  return results.length > 0 ? results : queryKnowledge(index, topic, options);
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function _filteredHints(
  index: KnowledgeHintIndex,
  options: KnowledgeQueryOptions
): KnowledgeHint[] {
  return index.hints.filter((hint) => {
    if (options.actuator && hint.tags) {
      if (!hint.tags.some((t) => t.toLowerCase() === options.actuator!.toLowerCase())) return false;
    }
    if (options.op && hint.tags) {
      if (!hint.tags.some((t) => t.toLowerCase() === options.op!.toLowerCase())) return false;
    }
    return true;
  });
}
