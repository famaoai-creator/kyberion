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
 * `knowledge/public/governance/restricted-action-kinds-policy.json`
 * and is reloaded on each call (small file, infrequent calls — simpler
 * than a cache + invalidation story). Operators can override the path
 * via `KYBERION_RESTRICTED_ACTIONS_POLICY` for tenant-scoped tightening.
 */

import { logger } from './core.js';
import * as pathResolver from './path-resolver.js';
import { safeReadFile } from './secure-io.js';

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

const DEFAULT_POLICY_PATH = 'knowledge/public/governance/restricted-action-kinds-policy.json';

export function loadRestrictedActionRules(opts?: {
  path?: string;
}): RestrictedActionRule[] {
  const rel =
    opts?.path ??
    process.env.KYBERION_RESTRICTED_ACTIONS_POLICY ??
    DEFAULT_POLICY_PATH;
  try {
    const abs = pathResolver.rootResolve(rel);
    const data = JSON.parse(safeReadFile(abs, { encoding: 'utf8' }) as string);
    return Array.isArray(data?.rules) ? (data.rules as RestrictedActionRule[]) : [];
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
  rules?: RestrictedActionRule[],
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
