import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { safeJsonParse } from './validators.js';

export type ToolRuntimeMode = 'trial' | 'approved_install' | 'installed' | 'pinned';
export type ToolRuntimeEcosystem = 'python' | 'node' | 'system';
export type ToolRuntimeModePreference = 'trial_first' | 'installed_first' | 'installed_only';

export interface ToolRuntimePolicy {
  version: string;
  managed_roots: {
    tool_runtime_root: string;
    cache_root: string;
  };
  mode_preference: Record<ToolRuntimeEcosystem, ToolRuntimeModePreference>;
  approval: {
    install_requires_approval: boolean;
    pin_requires_approval: boolean;
  };
}

const DEFAULT_POLICY_PATH = pathResolver.knowledge('product/governance/tool-runtime-policy.json');

const FALLBACK_POLICY: ToolRuntimePolicy = {
  version: 'fallback',
  managed_roots: {
    tool_runtime_root: 'active/shared/runtime',
    cache_root: 'active/shared/tmp/tool-runtime-cache',
  },
  mode_preference: {
    python: 'trial_first',
    node: 'installed_first',
    system: 'installed_first',
  },
  approval: {
    install_requires_approval: true,
    pin_requires_approval: true,
  },
};

let cachedPolicyPath: string | null = null;
let cachedPolicy: ToolRuntimePolicy | null = null;

function getPolicyPath(): string {
  return process.env.KYBERION_TOOL_RUNTIME_POLICY_PATH?.trim() || DEFAULT_POLICY_PATH;
}

export function resetToolRuntimePolicyCache(): void {
  cachedPolicyPath = null;
  cachedPolicy = null;
}

export function getToolRuntimePolicy(): ToolRuntimePolicy {
  const policyPath = getPolicyPath();
  if (cachedPolicyPath === policyPath && cachedPolicy) return cachedPolicy;

  if (!safeExistsSync(policyPath)) {
    cachedPolicyPath = policyPath;
    cachedPolicy = FALLBACK_POLICY;
    return cachedPolicy;
  }

  try {
    const raw = safeReadFile(policyPath, { encoding: 'utf8' }) as string;
    const parsed = safeJsonParse<ToolRuntimePolicy>(raw, 'tool runtime policy');
    cachedPolicyPath = policyPath;
    cachedPolicy = parsed;
    return parsed;
  } catch (error: any) {
    cachedPolicyPath = policyPath;
    cachedPolicy = FALLBACK_POLICY;
    return cachedPolicy;
  }
}

export function resolveToolRuntimeRoot(policy: ToolRuntimePolicy = getToolRuntimePolicy()): string {
  return pathResolver.rootResolve(policy.managed_roots.tool_runtime_root);
}

export function resolveToolRuntimeCacheRoot(policy: ToolRuntimePolicy = getToolRuntimePolicy()): string {
  return pathResolver.rootResolve(policy.managed_roots.cache_root);
}
