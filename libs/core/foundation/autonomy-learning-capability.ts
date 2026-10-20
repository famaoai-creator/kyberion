import type { ResourceAccessScope } from './resource-access-scope.js';
import * as path from 'node:path';
import { PARTITIONED_RUNTIME_STATE_ROOTS } from './runtime-state-roots.js';
import { getProcessEnv } from './process-env.js';
import { isValidTenantSlug } from './scope.js';

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
  const files = [
    directory + '/autonomy-outcomes.jsonl',
    directory + '/autonomy-action-overrides.json',
  ];
  return {
    tenantSlug,
    readExact: files,
    writeExact: files,
    mkdirExact: [
      path.posix.dirname(path.posix.dirname(directory)),
      path.posix.dirname(directory),
      directory,
    ],
  };
}

export function isAutonomyLearningCapability(scope: ResourceAccessScope | undefined): boolean {
  if (
    !scope ||
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
      JSON.stringify(scope.mkdirExact) === JSON.stringify(expected.mkdirExact)
    );
  } catch {
    return false;
  }
}
