import { pathResolver } from './path-resolver.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { resolveActiveProfileRoot } from './profile-root.js';
import { withExecutionContext } from './authority.js';
import { assertSafeRepositoryPath, safeExistsSync, safeWriteFile } from './secure-io.js';

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
const POLICY_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/tool-runtime-policy.schema.json'
);

let cachedPolicyPath: string | null = null;
let cachedPolicy: ToolRuntimePolicy | null = null;

function getPolicyPath(): string {
  const explicit = getRegisteredEnvText('KYBERION_TOOL_RUNTIME_POLICY_PATH')?.trim();
  if (explicit) return assertSafeRepositoryPath(explicit, { allowMissingLeaf: true });
  const operatorOverlay = `${resolveActiveProfileRoot()}/onboarding/tool-runtime-policy.json`;
  const candidate = safeExistsSync(operatorOverlay) ? operatorOverlay : DEFAULT_POLICY_PATH;
  return assertSafeRepositoryPath(candidate, { allowMissingLeaf: true });
}

const policyCatalog = defineCatalog<ToolRuntimePolicy>({
  id: 'tool-runtime-policy',
  path: getPolicyPath,
  schema: POLICY_SCHEMA_PATH,
});

export function _resetToolRuntimePolicyCacheForTests(): void {
  cachedPolicyPath = null;
  cachedPolicy = null;
  policyCatalog.reset();
}

export function getToolRuntimePolicy(): ToolRuntimePolicy {
  const policyPath = getPolicyPath();
  if (cachedPolicyPath === policyPath && cachedPolicy) return cachedPolicy;

  cachedPolicy = withExecutionContext(
    'sovereign_concierge',
    () => policyCatalog.load(),
    'ecosystem_architect'
  );
  cachedPolicyPath = policyPath;
  return cachedPolicy;
}

/** Validate and persist a profile policy through the same catalog as reads. */
export function writeToolRuntimePolicyAtPath(filePath: string, policy: ToolRuntimePolicy): string {
  const safePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
  const validated = defineCatalog<ToolRuntimePolicy>({
    id: 'tool-runtime-policy',
    path: safePath,
    schema: POLICY_SCHEMA_PATH,
  }).validate(policy, safePath);
  safeWriteFile(safePath, JSON.stringify(validated, null, 2) + '\n', {
    mkdir: true,
    encoding: 'utf8',
  });
  return safePath;
}

export function resolveToolRuntimeRoot(policy: ToolRuntimePolicy = getToolRuntimePolicy()): string {
  return pathResolver.rootResolve(policy.managed_roots.tool_runtime_root);
}

export function resolveToolRuntimeCacheRoot(
  policy: ToolRuntimePolicy = getToolRuntimePolicy()
): string {
  return pathResolver.rootResolve(policy.managed_roots.cache_root);
}
