/**
 * Tenant autonomy learning store grant (G2 of the store-catalog guard design).
 *
 * The exact ceiling of one tenant partition (`autonomyLearningCapability`) is
 * issued only as an opaque, synchronous grant of this module's private issuer
 * (`withAutonomyLearningCapability`, import-restricted to
 * governance/autonomy-action-state.ts by
 * tests/autonomy-learning-capability-boundary.test.ts). A structural lookalike,
 * a copy, a grant of another issuer, a captured continuation or a grant of a
 * second module instance resolves nothing (`isAutonomyLearningCapability`).
 *
 * G2: the live grant is itself the authority for the I/O it covers
 * (`autonomyLearningGrantAllows`, asked by tier-guard's store-grant table);
 * there is no store role.
 */
import {
  createSynchronousResourceGrantIssuer,
  currentResourceAccessScope,
  decideResourceAccess,
  type ResourceAccessOperation,
  type ResourceAccessScope,
} from './resource-access-scope.js';
import { registerStoreGrant } from './store-grant-registry.js';
import * as path from 'node:path';
import { PARTITIONED_RUNTIME_STATE_ROOTS } from './runtime-state-roots.js';
import { getProcessEnv } from './process-env.js';
import { isValidTenantSlug } from './scope.js';

/**
 * Issuance right of the autonomy learning grant (G2). The former shared core role of this name
 * is gone; the name stays only in role-assumption-policy `shared_core_roles`, which decides which
 * processes may issue the grant (authority.ts assertStoreGrantIssuanceAllowed). It is not an
 * assumable authority role.
 */
export const AUTONOMY_LEARNING_GRANT_ISSUANCE_RIGHT = 'autonomy_learning_store';

/** Internal store ceiling; contains no caller supplied paths or broader knowledge aliases. */
export function autonomyLearningCapability(
  tenantSlug: string,
  directory = PARTITIONED_RUNTIME_STATE_ROOTS.autonomy_learning + '/confidential/' + tenantSlug
): ResourceAccessScope {
  if (!isValidTenantSlug(tenantSlug))
    throw new Error('[RESOURCE_SCOPE_INVALID] Invalid autonomy tenant');
  const normal = PARTITIONED_RUNTIME_STATE_ROOTS.autonomy_learning + '/confidential/' + tenantSlug;
  const sandbox =
    /^active\/shared\/runtime\/vitest-live\/pool-[\w-]+\/shared\/runtime\/autonomy-learning\/confidential\//;
  if (
    directory !== normal &&
    !(
      getProcessEnv('VITEST') &&
      sandbox.test(directory) &&
      directory.slice(directory.lastIndexOf('/') + 1) === tenantSlug
    )
  ) {
    throw new Error('[RESOURCE_SCOPE_INVALID] Invalid autonomy store directory');
  }
  const outcomes = directory + '/autonomy-outcomes.jsonl';
  const files = [outcomes, directory + '/autonomy-action-overrides.json'];
  const archive = directory + '/compaction-archive';
  return {
    tenantSlug,
    readExact: files,
    writeExact: files,
    mkdirExact: [
      path.posix.dirname(path.posix.dirname(directory)),
      path.posix.dirname(directory),
      directory,
      archive,
    ],
    // Write-time window retention of the outcomes ledger only
    // (libs/core/storage/append-only-store.ts rewriteParked): its parked staging
    // copies, its two publish temp names, and its sibling compaction archive.
    // The store lock stays outside this capability, under the caller.
    namePrefixExact: [
      outcomes + '.compacting-',
      outcomes + '.compact-out-',
      outcomes + '.compact-restore-',
      archive + '/',
    ],
  };
}

interface AutonomyLearningBinding {
  readonly tenantSlug: string;
  readonly directory: string;
}
const grants = createSynchronousResourceGrantIssuer<AutonomyLearningBinding>(
  'AUTONOMY_LEARNING_CAPABILITY'
);

/**
 * Internal synchronous issuer of the exact tenant store ceiling, import-restricted to
 * governance/autonomy-action-state.ts. The opaque grant exists only while `internalFn` runs.
 */
export function withAutonomyLearningCapability<T>(
  tenantSlug: string,
  directory: string,
  internalFn: () => T
): T {
  const binding: AutonomyLearningBinding = Object.freeze({ tenantSlug, directory });
  return grants.run(binding, autonomyLearningCapability(tenantSlug, directory), internalFn);
}

/** Pure mandatory guard: only this issuer's live grant with its exact ceiling resolves. */
export function isAutonomyLearningCapability(scope: ResourceAccessScope | undefined): boolean {
  const grant = grants.resolve(scope);
  if (!grant || !scope) return false;
  if (
    scope.tenantSlug !== grant.binding.tenantSlug ||
    path.posix.dirname(scope.readExact[0] ?? '') !== grant.binding.directory ||
    (scope.appendExact?.length ?? 0) !== 0 ||
    scope.organizationId ||
    scope.projectId ||
    scope.allowProductKnowledgeRead ||
    (scope.metadataExact?.length ?? 0) !== 0
  )
    return false;
  try {
    const expected = autonomyLearningCapability(
      scope.tenantSlug,
      path.posix.dirname(scope.readExact[0] ?? '')
    );
    return (
      JSON.stringify(scope.readExact) === JSON.stringify(expected.readExact) &&
      JSON.stringify(scope.writeExact) === JSON.stringify(expected.writeExact) &&
      JSON.stringify(scope.mkdirExact) === JSON.stringify(expected.mkdirExact) &&
      JSON.stringify(scope.namePrefixExact ?? []) === JSON.stringify(expected.namePrefixExact ?? [])
    );
  } catch {
    return false;
  }
}

/**
 * Does the live grant authorize this I/O? Only inside its exact ceiling (no append or metadata
 * enlargement: the issuer attaches none) and only under the store root the former
 * `autonomy_learning_store` policy grant covered. The Vitest sandbox partition stays with the
 * caller's own policy, as it did under the role.
 */
export function autonomyLearningGrantAllows(
  target: string,
  operation: ResourceAccessOperation
): boolean {
  const scope = currentResourceAccessScope();
  if (!isAutonomyLearningCapability(scope)) return false;
  const root = PARTITIONED_RUNTIME_STATE_ROOTS.autonomy_learning;
  if (target !== root && !target.startsWith(root + '/')) return false;
  return decideResourceAccess(scope!, target, operation).allowed;
}

// G3: tier-guard asks this rule through the store grant registry, not by importing this module.
registerStoreGrant({
  id: 'autonomy-learning',
  authorizes: (target, operation) => autonomyLearningGrantAllows(target, operation),
});
