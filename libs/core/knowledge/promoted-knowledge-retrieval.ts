/**
 * Promoted knowledge retrieval (D8 / MEMORY_LOOP_CLOSURE M1).
 *
 * Promotion (`savePromotedMemoryRecord`) writes reviewed lessons to
 * `knowledge/product/evolution/{wisdom,operations,patterns,templates}/generated/`
 * (product domain) or `knowledge/public/common/<kind>/generated/` (public
 * organization records). This module returns the ones relevant to a topic so
 * later work receives them by relevance, not only when pinned. It replaces the
 * retired `distill_*` injector lane in the mission context pack.
 *
 * Ranking is the knowledge index's own (`buildScopedIndex` + lexical
 * `queryKnowledge`, the same deterministic path tenant retrieval uses); this
 * module only narrows the corpus to promoted records and filters by scope.
 *
 * Disclosure: the scanned roots are constructed positively — product and
 * public tiers only. Tenant-scoped promoted records
 * (`knowledge/confidential/<tenant>/**\/evolution/...`) reach a mission through
 * tenant retrieval, which scans exactly the reader's own tenant subtree.
 * Every hit is additionally admitted with `memoryScopeAllowsRead` against the
 * reader's scope, so a confidential or personal record can never pass here.
 *
 * Fail-open for retrieval (any error yields `[]`), fail-closed for scope.
 */
import * as path from 'node:path';
import { createLogger } from '../logger.js';
import * as pathResolver from '../path-resolver.js';
import type { ScopeContext } from '../scope-context.js';
import {
  KnowledgeHintIndex,
  buildScopedIndex,
  queryKnowledge,
  type KnowledgeHint,
} from './knowledge-index.js';
import { memoryScopeAllowsRead, type MemoryScopeEnvelope } from './memory-scope.js';
import { readTextFile } from '../foundation/text.js';

const KIND_DIRS = '(?:wisdom|operations|patterns|templates)';
const PROMOTED_RECORD_PATTERNS: readonly RegExp[] = [
  // Product domain (savePromotedMemoryRecord, domain=product).
  new RegExp(`^knowledge/product/evolution/${KIND_DIRS}/generated/[^/]+\\.md$`),
  // Unscoped organization records (public / legacy tenantless tiers).
  new RegExp(
    `^knowledge/(?:public|confidential|personal)/common/${KIND_DIRS}/generated/[^/]+\\.md$`
  ),
  // Personal owner records.
  new RegExp(`^knowledge/personal/owners/[^/]+/${KIND_DIRS}/generated/[^/]+\\.md$`),
  // Tenant (and narrower scoped SOP) records.
  new RegExp(`^knowledge/confidential/[^/]+/(?:[^/]+/)*evolution/${KIND_DIRS}/[^/]+\\.md$`),
];

/** True when a repo-relative path is a promoted memory record (any tier). */
export function isPromotedKnowledgePath(documentPath: string): boolean {
  const normalized = documentPath.replace(/\\/g, '/').split('#chunk', 1)[0];
  return PROMOTED_RECORD_PATTERNS.some((pattern) => pattern.test(normalized));
}

/** The tier/tenant a promoted record discloses to, derived from its location. */
export function promotedRecordSourceScope(documentPath: string): MemoryScopeEnvelope {
  const normalized = documentPath.replace(/\\/g, '/');
  if (normalized.startsWith('knowledge/personal/')) return { tier: 'personal' };
  const tenant = normalized.match(/^knowledge\/confidential\/([^/]+)\//)?.[1];
  if (normalized.startsWith('knowledge/confidential/'))
    return tenant && tenant !== 'common'
      ? { tier: 'confidential', tenant_slug: tenant }
      : // Tenantless confidential records have no reader this lane can prove.
        { tier: 'personal' };
  return { tier: 'public' };
}

/** Pack-hint shaped hit; field names match the retired distill entry. */
export interface PromotedKnowledgeEntry {
  /** Repo-relative path, e.g. knowledge/product/evolution/wisdom/generated/x.md */
  path: string;
  title: string;
  excerpt: string;
  tags: string[];
  source_sha256?: string;
  /** Lexical relevance from `queryKnowledge` (0..1 band). */
  score: number;
}

export interface FindRelevantPromotedKnowledgeInput {
  topic: string;
  limit?: number;
  /** Drop hits whose lexical score is below this. Defaults to any match. */
  minScore?: number;
  /** Reader scope. Omitted = a public, tenantless reader. */
  scope?: ScopeContext;
  /** Test seam: repo root containing a fixture `knowledge/`. */
  rootDir?: string;
}

const EXCERPT_MAX_CHARS = 400;
const logger = createLogger('promoted-knowledge-retrieval');

/** A record replaced (`superseded_by`) or withdrawn (`validity`) is not delivered. */
function isRetiredRecord(knowledgeBase: string, documentPath: string): boolean {
  try {
    const text = readTextFile(path.join(knowledgeBase, documentPath.slice('knowledge/'.length)));
    const end = text.startsWith('---\n') ? text.indexOf('\n---', 4) : -1;
    if (end < 0) return false;
    const field = (key: string) =>
      text
        .slice(4, end)
        .match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm'))?.[1]
        ?.trim()
        .replace(/^['"]|['"]$/g, '') ?? '';
    return Boolean(field('superseded_by')) || ['revoked', 'corrected'].includes(field('validity'));
  } catch {
    return true;
  }
}

function repoRelative(source: string): string | null {
  const canonical = path.posix.normalize(source.replace(/\\/g, '/').split('#chunk', 1)[0]);
  if (!canonical || canonical.startsWith('..') || path.posix.isAbsolute(canonical)) return null;
  return `knowledge/${canonical}`;
}

/**
 * Promoted records relevant to `topic`, readable by `scope`, best first
 * (score desc, then path). Fail-open: any error yields `[]`.
 */
export async function findRelevantPromotedKnowledge(
  input: FindRelevantPromotedKnowledgeInput
): Promise<PromotedKnowledgeEntry[]> {
  const limit = Math.max(0, Math.floor(input.limit ?? 5));
  if (!limit || !input.topic.trim()) return [];
  const reader: ScopeContext = input.scope ?? { tier: 'public' };
  try {
    const knowledgeBase = input.rootDir
      ? path.join(input.rootDir, 'knowledge')
      : pathResolver.knowledge();
    // Positive roots: product/evolution and public/common only.
    const scanned = await buildScopedIndex(
      { tiers: ['product', 'public'], domains: ['evolution', 'common'] },
      knowledgeBase,
      { hydrateEmbeddings: false }
    );
    const promoted = scanned.hints.filter((hint: KnowledgeHint) => {
      const documentPath = repoRelative(hint.parentSource || hint.source);
      return Boolean(documentPath && isPromotedKnowledgePath(documentPath));
    });
    const index = new KnowledgeHintIndex(promoted, scanned.scope);
    const ranked = queryKnowledge(index, input.topic, {
      maxResults: promoted.length,
      includeScores: true,
      ...(input.scope ? { scopeContext: input.scope } : {}),
    });
    const out: PromotedKnowledgeEntry[] = [];
    for (const hint of ranked) {
      const documentPath = repoRelative(hint.source);
      if (!documentPath || !isPromotedKnowledgePath(documentPath)) continue;
      if (!memoryScopeAllowsRead(promotedRecordSourceScope(documentPath), reader)) continue;
      const score = typeof hint.score === 'number' ? hint.score : 0;
      if (score < (input.minScore ?? Number.MIN_VALUE)) continue;
      if (isRetiredRecord(knowledgeBase, documentPath)) continue;
      out.push({
        path: documentPath,
        title: hint.topic,
        excerpt: hint.hint.trim().replace(/\s+/g, ' ').slice(0, EXCERPT_MAX_CHARS) || hint.topic,
        tags: hint.tags ?? [],
        ...(hint.source_sha256 ? { source_sha256: hint.source_sha256 } : {}),
        score,
      });
    }
    return out
      .sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .slice(0, limit);
  } catch (error) {
    logger.warn(
      `[memory-loop] promoted knowledge retrieval skipped — ${
        error instanceof Error ? error.message : String(error)
      } | next: inspect knowledge/product/evolution and the knowledge index | evidence: topic=${input.topic.slice(0, 80)}`
    );
    return [];
  }
}

/** One-line summary for prompt injection or UI display. */
export function formatPromotedKnowledgeSummary(entry: PromotedKnowledgeEntry): string {
  const tags = entry.tags.length ? ` [${entry.tags.slice(0, 3).join(', ')}]` : '';
  return `- ${entry.title}${tags} (score=${entry.score.toFixed(2)})\n  ${entry.excerpt.slice(0, 160)}…\n  source: ${entry.path}`;
}

/**
 * @deprecated D8 retired the `distill_*` injector lane. Kept for one release
 * as an alias over the promoted lane; use {@link PromotedKnowledgeEntry}.
 */
export type DistilledKnowledgeEntry = PromotedKnowledgeEntry;

/** @deprecated Use {@link FindRelevantPromotedKnowledgeInput}; `tags` join the topic. */
export interface FindRelevantInput {
  topic: string;
  tags?: string[];
  limit?: number;
  minScore?: number;
  scope?: ScopeContext;
}

/**
 * @deprecated D8: the `distill_*` corpus is historical and its injector is
 * deleted. This alias queries promoted records instead (tags join the topic).
 * Use {@link findRelevantPromotedKnowledge}; removed in the next release.
 */
export async function findRelevantDistilledKnowledge(
  input: FindRelevantInput
): Promise<DistilledKnowledgeEntry[]> {
  return findRelevantPromotedKnowledge({
    topic: [input.topic, ...(input.tags ?? [])].filter(Boolean).join(' '),
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
    ...(input.minScore !== undefined ? { minScore: input.minScore } : {}),
    ...(input.scope ? { scope: input.scope } : {}),
  });
}

/** @deprecated Use {@link formatPromotedKnowledgeSummary}. */
export const formatDistilledKnowledgeSummary = formatPromotedKnowledgeSummary;
