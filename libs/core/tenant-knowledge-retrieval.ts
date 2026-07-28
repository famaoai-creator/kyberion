/**
 * Tenant knowledge retrieval (DA-07): the single choke point where a
 * tenant-scoped knowledge search scope is constructed.
 *
 * DA-05 lands tenant knowledge under `knowledge/confidential/{tenant}/`, but
 * the mission context pack only ever queried the distill corpus
 * (`findRelevantDistilledKnowledge`), so ingested tenant knowledge never
 * reached missions. This module makes it reachable by querying the scoped
 * knowledge index (`buildScopedIndex` / `queryKnowledge`) over a POSITIVELY
 * constructed allowlist of roots — never a blocklist:
 *
 *   1. the tenant's own confidential subtree (`ResolvedTenant.knowledge_root`,
 *      default `knowledge/confidential/{slug}`),
 *   2. the tenant's `customer/{slug}/` overlay (scanned via the dedicated
 *      `'customer'` index tier, which never touches `knowledge/personal/`),
 *   3. `knowledge/confidential/common` — UNLESS the tenant profile declares
 *      `isolation_policy.strict_isolation === true`, in which case only the
 *      tenant's own subtree (and overlay) is in scope.
 *
 * Isolation is enforced here and only here: every scope names exactly one
 * subtree (`customerId` on the index scope), so a document under any OTHER
 * tenant's root is structurally unreachable regardless of how well it would
 * score — there is no "scan all of confidential/ then filter" path.
 *
 * Failure contract (deliberately asymmetric):
 * - fail-OPEN for retrieval: a missing/invalid tenant profile, a missing
 *   knowledge root, or any scan/query error yields `[]` — pack building must
 *   never crash because tenant knowledge is absent.
 * - fail-CLOSED for isolation: the same `[]` outcome means nothing outside
 *   the allowlist is ever returned; there is no degraded wider scan.
 *
 * Determinism: retrieval uses the lexical `queryKnowledge` ranking (with
 * `includeScores`) rather than the embedding-hybrid path, so results are
 * reproducible in hermetic tests and independent of which embedding backend
 * happens to be installed. Unifying this with the hybrid ranker is the KM-02
 * Task 4 residual, tracked there — not silently decided here.
 */

import * as path from 'node:path';
import * as pathResolver from './path-resolver.js';
import {
  buildScopedIndex,
  queryKnowledge,
  type KnowledgeHint,
  type KnowledgeScope,
} from './src/knowledge-index.js';
import { resolveTenant, type TenantRegistryPathOptions } from './tenant-registry.js';
import { logger } from './core.js';

const TENANT_CONFIDENTIAL_PREFIX = 'knowledge/confidential/';
const EXCERPT_MAX_CHARS = 400;

/** One tenant-scoped retrieval hit, repo-relative and pack-hint shaped. */
export interface TenantKnowledgeHit {
  /** Repo-relative path (e.g. `knowledge/confidential/tenant-masked-a/x.md`, `customer/tenant-masked-a/y.md`). */
  path: string;
  title: string;
  excerpt: string;
  tags: string[];
  /** Lexical relevance score from `queryKnowledge` (0..1 band). */
  score: number;
  /** The tenant this hit was retrieved for (provenance, not a filter). */
  tenant_slug: string;
}

export interface TenantKnowledgeScopeSet {
  tenantSlug: string;
  /** True when the profile declares isolation_policy.strict_isolation === true. */
  strictIsolation: boolean;
  /** Positively constructed scopes — each names exactly one subtree. */
  scopes: KnowledgeScope[];
}

export interface QueryTenantKnowledgeInput {
  tenantSlug: string;
  /** Free-text topic — same string the distill corpus is queried with. */
  topic: string;
  /** Maximum hits returned across all scopes. */
  limit: number;
  /**
   * Test seam: repo root containing the fixture `knowledge/`, `customer/`,
   * and tenant profile directories. Defaults to the real repo root.
   */
  rootDir?: string;
  /** Test seam: env for tenant profile directory resolution. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

const warnedTenants = new Set<string>();

function warnOncePerTenant(slug: string, message: string): void {
  if (warnedTenants.has(slug)) return;
  warnedTenants.add(slug);
  logger.warn(message);
}

/** Test-only: clear the warn-once log so fixtures can assert warnings. */
export function _resetTenantKnowledgeWarningsForTests(): void {
  warnedTenants.clear();
}

/**
 * Build the positive allowlist of index scopes for one tenant. Returns null
 * (fail-open for retrieval, fail-closed for isolation — nothing gets scanned)
 * when the tenant cannot be resolved to a registered profile, or when its
 * declared knowledge root does not live under `knowledge/confidential/`.
 */
export function buildTenantKnowledgeScopeSet(
  tenantSlug: string,
  options: TenantRegistryPathOptions = {}
): TenantKnowledgeScopeSet | null {
  let resolved;
  try {
    resolved = resolveTenant(tenantSlug, options);
  } catch (error) {
    warnOncePerTenant(
      tenantSlug,
      `[DA-07] tenant '${tenantSlug}' not resolvable; skipping tenant knowledge retrieval (fail-open): ${
        (error as Error)?.message || String(error)
      }`
    );
    return null;
  }

  const knowledgeRoot = resolved.knowledge_root.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!knowledgeRoot.startsWith(TENANT_CONFIDENTIAL_PREFIX)) {
    // A root outside knowledge/confidential/ has no single-subtree scope in
    // the index; refusing to scan is the fail-closed choice.
    warnOncePerTenant(
      tenantSlug,
      `[DA-07] tenant '${tenantSlug}' knowledge_root '${knowledgeRoot}' is outside knowledge/confidential/; skipping tenant knowledge retrieval`
    );
    return null;
  }
  const tenantSubdir = knowledgeRoot.slice(TENANT_CONFIDENTIAL_PREFIX.length);
  const strictIsolation = resolved.profile.isolation_policy?.strict_isolation === true;

  const scopes: KnowledgeScope[] = [
    // The tenant's own confidential subtree — customerId restricts the
    // confidential scanner to exactly this subdirectory.
    { tiers: ['confidential'], customerId: tenantSubdir },
    // The customer/{slug}/ overlay — 'customer' tier scans ONLY the overlay.
    { tiers: ['customer'], customerId: tenantSlug },
  ];
  if (!strictIsolation) {
    scopes.push({ tiers: ['confidential'], customerId: 'common' });
  }

  return { tenantSlug, strictIsolation, scopes };
}

/** Rewrite an index-internal source (relative to knowledge/) to a repo-relative path. */
function toRepoRelativePath(source: string): string {
  const normalized = source.replace(/\\/g, '/');
  // Customer-overlay sources are relative to knowledge/ and therefore start
  // with '../' (the overlay lives beside knowledge/, under customer/).
  if (normalized.startsWith('../')) return normalized.slice(3);
  return `knowledge/${normalized}`;
}

function toHit(hint: KnowledgeHint, tenantSlug: string): TenantKnowledgeHit {
  const excerpt = hint.hint.trim().replace(/\s+/g, ' ').slice(0, EXCERPT_MAX_CHARS);
  return {
    path: toRepoRelativePath(hint.source),
    title: hint.topic,
    excerpt: excerpt || hint.topic,
    tags: hint.tags ?? [],
    score: typeof hint.score === 'number' ? hint.score : 0,
    tenant_slug: tenantSlug,
  };
}

/**
 * Query the tenant's knowledge (own subtree + overlay + common unless strict)
 * for `topic`. Deterministic ordering: score descending, ties broken by
 * repo-relative path (codepoint order); de-duplicated by path. Fail-open:
 * any error yields `[]`.
 */
export async function queryTenantKnowledge(
  input: QueryTenantKnowledgeInput
): Promise<TenantKnowledgeHit[]> {
  const limit = Math.max(0, Math.floor(input.limit));
  if (limit === 0 || !input.topic.trim() || !input.tenantSlug.trim()) return [];

  try {
    const scopeSet = buildTenantKnowledgeScopeSet(input.tenantSlug, {
      ...(input.rootDir ? { rootDir: input.rootDir } : {}),
      ...(input.env ? { env: input.env } : {}),
    });
    if (!scopeSet) return [];

    const knowledgeBase = input.rootDir
      ? path.join(input.rootDir, 'knowledge')
      : pathResolver.knowledge();

    const byPath = new Map<string, TenantKnowledgeHit>();
    for (const scope of scopeSet.scopes) {
      const index = await buildScopedIndex(scope, knowledgeBase);
      const results = queryKnowledge(index, input.topic, {
        maxResults: limit,
        includeScores: true,
      });
      for (const hint of results) {
        const hit = toHit(hint, scopeSet.tenantSlug);
        const existing = byPath.get(hit.path);
        if (!existing || hit.score > existing.score) byPath.set(hit.path, hit);
      }
    }

    return Array.from(byPath.values())
      .sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .slice(0, limit);
  } catch (error) {
    warnOncePerTenant(
      input.tenantSlug,
      `[DA-07] tenant knowledge retrieval failed for '${input.tenantSlug}' (fail-open): ${
        (error as Error)?.message || String(error)
      }`
    );
    return [];
  }
}
