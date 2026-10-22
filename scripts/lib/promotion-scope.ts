/**
 * Shared tier guard for the promotion commands (`pipeline:promote`,
 * `scratch:promote`): a promotion may move scratch material up into a
 * durable catalog, never down a tier or across tenants.
 */
import * as nodePath from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import {
  classifyPromotionSourceScope,
  isUnknownTierSource,
  type PromotionSourceScope,
} from '@agent/core/scratch-promotion';

/** Repo-relative POSIX form of an absolute path inside the repository. */
export function repoRelative(absolutePath: string): string {
  return nodePath.relative(pathResolver.rootDir(), absolutePath).split(nodePath.sep).join('/');
}

/**
 * Tier guard for a promotion source (shared by pipeline:promote and
 * scratch:promote). Returns the source scope, or throws a diagnostic when the
 * requested target would move the data to a lower tier or another tenant:
 * - public target (no tenant) + tier/tenant-bound source → refused;
 * - public target + unpartitioned (tier-unknown) scratch → refused unless the
 *   operator acknowledges it with --source-is-public;
 * - tenant target + personal source → refused (personal never leaves its tier);
 * - tenant target + source bound to a different tenant → refused.
 */
export function assertPromotionSourceScope(
  sourceRepoPath: string,
  targetTenant: string | undefined,
  command = 'pipeline:promote',
  options: { sourceIsPublic?: boolean } = {}
): PromotionSourceScope | null {
  // Diagnostics carry the calling command's prefix ([promote] / [scratch:promote]).
  const tag = command === 'pipeline:promote' ? '[promote]' : `[${command}]`;
  const scope = classifyPromotionSourceScope(sourceRepoPath);
  if (!scope) {
    // Unpartitioned scratch has no declared tier and routinely holds
    // confidential material: a public target needs an explicit acknowledgement.
    if (!targetTenant && !options.sourceIsPublic && isUnknownTierSource(sourceRepoPath)) {
      throw new Error(
        `${tag} public promotion refused — the source is unpartitioned scratch whose tier is unknown | ` +
          `rerun with --tenant <slug> (pnpm ${command} … --tenant <slug>), or confirm the content is public with --source-is-public | ` +
          `evidence: source=${sourceRepoPath}`
      );
    }
    return null;
  }
  const evidence = `source=${sourceRepoPath} scope=${scope.location}`;
  if (!targetTenant) {
    throw new Error(
      `${tag} public promotion refused — the source is ${scope.tier}${
        scope.tenant ? ` data of tenant '${scope.tenant}'` : ' tier data'
      } and the public target would downgrade it | ` +
        `rerun with --tenant ${scope.tenant ?? '<slug>'} to land it in knowledge/confidential/${
          scope.tenant ?? '<slug>'
        }/ (pnpm ${command} … --tenant ${scope.tenant ?? '<slug>'}) | evidence: ${evidence}`
    );
  }
  if (scope.tier === 'personal') {
    throw new Error(
      `${tag} tenant promotion refused — personal-tier data never leaves the personal tier | ` +
        `copy only non-personal material into a confidential/${targetTenant} scratch path first | evidence: ${evidence}`
    );
  }
  if (scope.tenant && scope.tenant !== targetTenant) {
    throw new Error(
      `${tag} cross-tenant promotion refused — the source belongs to tenant '${scope.tenant}', not '${targetTenant}' | ` +
        `rerun with --tenant ${scope.tenant}, or use a brokered mission for cross-tenant reuse | evidence: ${evidence}`
    );
  }
  return scope;
}
