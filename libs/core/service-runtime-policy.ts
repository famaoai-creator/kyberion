import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { safeJsonParse } from './validators.js';

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

const DEFAULT_POLICY_PATH = pathResolver.knowledge('product/governance/service-runtime-policy.json');

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

let cachedPolicyPath: string | null = null;
let cachedPolicy: ServiceRuntimePolicy | null = null;

function getPolicyPath(): string {
  return process.env.KYBERION_SERVICE_RUNTIME_POLICY_PATH?.trim() || DEFAULT_POLICY_PATH;
}

function loadPolicyFromPath(policyPath: string): ServiceRuntimePolicy {
  const raw = safeReadFile(policyPath, { encoding: 'utf8' }) as string;
  return safeJsonParse<ServiceRuntimePolicy>(raw, 'service runtime policy');
}

export function resetServiceRuntimePolicyCache(): void {
  cachedPolicyPath = null;
  cachedPolicy = null;
}

export function getServiceRuntimePolicy(): ServiceRuntimePolicy {
  const policyPath = getPolicyPath();
  if (cachedPolicyPath === policyPath && cachedPolicy) return cachedPolicy;

  if (!safeExistsSync(policyPath)) {
    cachedPolicyPath = policyPath;
    cachedPolicy = FALLBACK_POLICY;
    return cachedPolicy;
  }

  try {
    const parsed = loadPolicyFromPath(policyPath);
    cachedPolicyPath = policyPath;
    cachedPolicy = parsed;
    return parsed;
  } catch {
    cachedPolicyPath = policyPath;
    cachedPolicy = FALLBACK_POLICY;
    return cachedPolicy;
  }
}

export function resolveServiceRuntimeRoot(policy: ServiceRuntimePolicy = getServiceRuntimePolicy()): string {
  return pathResolver.rootResolve(policy.managed_roots.service_runtime_root);
}

export function resolveServiceRuntimeCacheRoot(policy: ServiceRuntimePolicy = getServiceRuntimePolicy()): string {
  return pathResolver.rootResolve(policy.managed_roots.cache_root);
}
