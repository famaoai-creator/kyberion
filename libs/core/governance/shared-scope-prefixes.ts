import { pathResolver } from '../path-resolver.js';
import { safeExistsSync, safeReadFile, safeStat } from '../secure-io.js';
import { parseSafeJsonInput } from '../foundation/safe-json.js';
import { createLogger } from '../logger.js';

const logger = createLogger('shared-scope-prefixes');

/**
 * The repo-relative confidential knowledge root. Shared-owner segments are the
 * first path segment below it.
 */
export const KNOWLEDGE_CONFIDENTIAL_PREFIX = 'knowledge/confidential/';

const SECURITY_POLICY_REL = 'product/governance/security-policy.json';

/**
 * Fallback when security-policy.json is absent or its `tenant_scope` lacks a
 * well-formed `shared_prefixes` list: mirrors the prefixes the shipped policy
 * declares under `knowledge/confidential/` (tenantScopeConfig's own fallback
 * stays narrower — it guards writes, where a smaller shared set is safer).
 */
const DEFAULT_CONFIDENTIAL_SHARED_PREFIXES = [
  'knowledge/confidential/tenant-groups/',
  'knowledge/confidential/heuristics/',
  'knowledge/confidential/relationships/',
  'knowledge/confidential/common/',
] as const;

export interface SharedConfidentialScope {
  /** Repo-relative shared prefixes confined under `knowledge/confidential/`. */
  readonly prefixes: readonly string[];
  /**
   * First path segment under `knowledge/confidential/` for each shared
   * prefix (e.g. `tenant-groups`, `heuristics`, `relationships`, `common`).
   * These names are shared scope, never a tenant slug.
   */
  readonly ownerSegments: ReadonlySet<string>;
}

function deriveScope(prefixes: readonly string[]): SharedConfidentialScope {
  const confined = prefixes.filter(
    (prefix): prefix is string =>
      typeof prefix === 'string' &&
      prefix.startsWith(KNOWLEDGE_CONFIDENTIAL_PREFIX) &&
      prefix.length > KNOWLEDGE_CONFIDENTIAL_PREFIX.length
  );
  const ownerSegments = new Set(
    confined
      .map((prefix) => prefix.slice(KNOWLEDGE_CONFIDENTIAL_PREFIX.length).split('/')[0])
      .filter((segment): segment is string => Boolean(segment))
  );
  return { prefixes: confined, ownerSegments };
}

/**
 * Pure projection of `tenant_scope.shared_prefixes` — the single source for
 * which `knowledge/confidential/<segment>/` subtrees are shared rather than
 * tenant-owned (canonical-registry-consolidation.md). Callers that already
 * hold the parsed policy use this; otherwise `loadSharedConfidentialScope`.
 */
export function sharedConfidentialScopeFromPolicy(policy: unknown): SharedConfidentialScope {
  const raw = (policy as { tenant_scope?: { shared_prefixes?: unknown } } | null | undefined)
    ?.tenant_scope?.shared_prefixes;
  const list =
    Array.isArray(raw) && raw.every((prefix) => typeof prefix === 'string')
      ? (raw as string[])
      : DEFAULT_CONFIDENTIAL_SHARED_PREFIXES;
  return deriveScope(list);
}

let cachedScope: { mtimeMs: number; scope: SharedConfidentialScope } | undefined;

/**
 * Policy-backed shared scope, cached by policy mtime so a rewritten
 * security-policy.json takes effect on the next call (tests rewrite it).
 * An absent policy file falls back to the shipped defaults — the same
 * fail-open-on-absent-file behavior the previous hardcoded sets had; a
 * present-but-unparseable file also falls back and is logged once per change,
 * because attribution must keep working for non-guard callers.
 */
export function loadSharedConfidentialScope(): SharedConfidentialScope {
  const policyPath = pathResolver.knowledge(SECURITY_POLICY_REL);
  try {
    const mtimeMs = safeExistsSync(policyPath) ? safeStat(policyPath).mtimeMs : -1;
    if (cachedScope && cachedScope.mtimeMs === mtimeMs) return cachedScope.scope;
    let scope: SharedConfidentialScope;
    if (mtimeMs < 0) {
      scope = sharedConfidentialScopeFromPolicy(null);
    } else {
      try {
        const parsed = parseSafeJsonInput(
          safeReadFile(policyPath, { encoding: 'utf8' }) as string,
          'security-policy'
        );
        scope = sharedConfidentialScopeFromPolicy(parsed);
      } catch (error) {
        logger.warn(
          `shared-scope-prefixes: security-policy.json unreadable — why: ${error instanceof Error ? error.message : error} | next: using shipped shared-prefix defaults | evidence: ${SECURITY_POLICY_REL}`
        );
        scope = sharedConfidentialScopeFromPolicy(null);
      }
    }
    cachedScope = { mtimeMs, scope };
    return scope;
  } catch {
    return sharedConfidentialScopeFromPolicy(null);
  }
}

/** Whether `segment` (the name directly under `knowledge/confidential/`) is shared, never a tenant. */
export function isSharedConfidentialOwner(segment: string | undefined, policy?: unknown): boolean {
  if (!segment) return false;
  const scope =
    policy === undefined
      ? loadSharedConfidentialScope()
      : sharedConfidentialScopeFromPolicy(policy);
  return scope.ownerSegments.has(segment);
}

/** The shared `knowledge/confidential/` prefixes (policy-derived, defaults when absent). */
export function sharedConfidentialPrefixes(policy?: unknown): readonly string[] {
  return (
    policy === undefined ? loadSharedConfidentialScope() : sharedConfidentialScopeFromPolicy(policy)
  ).prefixes;
}
