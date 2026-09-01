import { pathResolver } from './path-resolver.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { assertSafeRepositoryPath } from './secure-io.js';

export type ServiceRuntimeMode = 'trial' | 'approved_install' | 'installed' | 'pinned';
export type ServiceRuntimeModePreference = 'trial_first' | 'installed_first' | 'installed_only';

export interface ServiceRuntimePolicy {
  version: string;
  managed_roots: {
    service_runtime_root: string;
    cache_root: string;
  };
  mode_preference: {
    local_service: ServiceRuntimeModePreference;
    remote_service: ServiceRuntimeModePreference;
  };
  approval: {
    provision_requires_approval: boolean;
    pin_requires_approval: boolean;
  };
}

const DEFAULT_POLICY_PATH = pathResolver.knowledge(
  'product/governance/service-runtime-policy.json'
);

const FALLBACK_POLICY: ServiceRuntimePolicy = {
  version: 'fallback',
  managed_roots: {
    service_runtime_root: 'active/shared/runtime',
    cache_root: 'active/shared/tmp/service-runtime-cache',
  },
  mode_preference: {
    local_service: 'trial_first',
    remote_service: 'installed_first',
  },
  approval: {
    provision_requires_approval: true,
    pin_requires_approval: true,
  },
};

function getPolicyPath(): string {
  return assertSafeRepositoryPath(
    getRegisteredEnvText('KYBERION_SERVICE_RUNTIME_POLICY_PATH')?.trim() || DEFAULT_POLICY_PATH,
    { allowMissingLeaf: true }
  );
}

const policyCatalog = defineCatalog<ServiceRuntimePolicy>({
  id: 'service-runtime-policy',
  path: getPolicyPath,
  schema: pathResolver.knowledge('product/schemas/service-runtime-policy.schema.json'),
  fallback: FALLBACK_POLICY,
});

export function _resetServiceRuntimePolicyCacheForTests(): void {
  policyCatalog.reset();
}

export function getServiceRuntimePolicy(): ServiceRuntimePolicy {
  try {
    return policyCatalog.load();
  } catch {
    return FALLBACK_POLICY;
  }
}

export function resolveServiceRuntimeRoot(
  policy: ServiceRuntimePolicy = getServiceRuntimePolicy()
): string {
  return assertSafeRepositoryPath(
    pathResolver.rootResolve(policy.managed_roots.service_runtime_root),
    { allowMissingLeaf: true }
  );
}

export function resolveServiceRuntimeCacheRoot(
  policy: ServiceRuntimePolicy = getServiceRuntimePolicy()
): string {
  return assertSafeRepositoryPath(pathResolver.rootResolve(policy.managed_roots.cache_root), {
    allowMissingLeaf: true,
  });
}
