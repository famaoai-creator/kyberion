/**
 * Restricted-action-kinds policy (Compliance-2).
 *
 * Pattern-driven matcher for action items whose title / summary names
 * an irreversible or compliance-loaded action (financial transfer,
 * contract signing, regulatory notice, destructive data ops, ...).
 * Items that match are flagged so the self-execution gate can block
 * them until an operator explicitly approves.
 *
 * The policy file lives at
 * `knowledge/product/governance/restricted-action-kinds-policy.json`
 * and is reloaded on each call (small file, infrequent calls — simpler
 * than a cache + invalidation story). Operators can override the path
 * via `KYBERION_RESTRICTED_ACTIONS_POLICY` for tenant-scoped tightening.
 */

import { logger } from './core.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import * as pathResolver from './path-resolver.js';
import { assertSafeRepositoryPath } from './secure-io.js';

export interface RestrictedActionRule {
  id: string;
  label: string;
  patterns: string[];
  rationale?: string;
  severity?: 'low' | 'medium' | 'high';
}

export interface RestrictedActionMatch {
  id: string;
  label: string;
  /** Index into the rule's `patterns` array — kept for audit. */
  pattern_index: number;
}

const DEFAULT_POLICY_PATH = 'knowledge/product/governance/restricted-action-kinds-policy.json';
const POLICY_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/restricted-action-kinds-policy.schema.json'
);

interface RestrictedActionPolicyFile {
  rules: RestrictedActionRule[];
}

const restrictedActionCatalog = defineCatalog<RestrictedActionPolicyFile>({
  id: 'restricted-action-kinds-policy',
  path: () =>
    assertSafeRepositoryPath(pathResolver.rootResolve(DEFAULT_POLICY_PATH), {
      allowMissingLeaf: true,
    }),
  schema: POLICY_SCHEMA_PATH,
  fallback: { rules: [] },
  fallbackOnInvalid: true,
  onFallback: (error) => {
    logger.warn(`[restricted-actions] policy load failed: ${String(error)}`);
  },
});

export function loadRestrictedActionRules(opts?: { path?: string }): RestrictedActionRule[] {
  const rel =
    opts?.path ?? getRegisteredEnvText('KYBERION_RESTRICTED_ACTIONS_POLICY') ?? DEFAULT_POLICY_PATH;
  const safePath = assertSafeRepositoryPath(pathResolver.rootResolve(rel), {
    allowMissingLeaf: true,
  });
  try {
    if (safePath === pathResolver.rootResolve(DEFAULT_POLICY_PATH)) {
      return restrictedActionCatalog.load().rules;
    }
    return defineCatalog<RestrictedActionPolicyFile>({
      id: 'restricted-action-kinds-policy',
      path: safePath,
      schema: POLICY_SCHEMA_PATH,
      fallback: { rules: [] },
      fallbackOnInvalid: true,
      onFallback: (error) => {
        logger.warn(`[restricted-actions] policy load failed: ${String(error)}`);
      },
    }).load().rules;
  } catch (err: any) {
    logger.warn(`[restricted-actions] policy load failed: ${err?.message ?? err}`);
    return [];
  }
}

/**
 * Match a candidate item against the loaded policy.
 *
 * The pattern is case-insensitive. The matcher does not implicitly
 * apply word boundaries — those should live in the policy patterns
 * (e.g. `\\bwire\\b ...`) so a CJK-character pattern doesn't break
 * (Japanese has no word-boundary equivalent for `\b`).
 */
export function matchRestrictedAction(
  item: { title: string; summary?: string },
  rules?: RestrictedActionRule[]
): RestrictedActionMatch | null {
  const allRules = rules ?? loadRestrictedActionRules();
  if (!allRules.length) return null;
  const haystack = `${item.title}\n${item.summary ?? ''}`;
  for (const rule of allRules) {
    for (let i = 0; i < rule.patterns.length; i++) {
      const pat = rule.patterns[i];
      try {
        if (new RegExp(pat, 'i').test(haystack)) {
          return { id: rule.id, label: rule.label, pattern_index: i };
        }
      } catch {
        logger.warn(`[restricted-actions] invalid pattern in rule ${rule.id}: ${pat}`);
      }
    }
  }
  return null;
}
