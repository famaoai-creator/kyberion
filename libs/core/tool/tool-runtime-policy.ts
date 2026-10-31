import * as path from 'node:path';
import { pathResolver } from '../path-resolver.js';
import {
  resolveStorageFloor,
  storageFloorRelativePath,
  SYSTEM_PARTITION,
} from '../storage-layout.js';
import { defineCatalog } from '../foundation/governed-catalog.js';
import { getRegisteredEnvText } from '../foundation/env.js';
import { resolveActiveProfileRoot } from '../profile-root.js';
import { withExecutionContext } from '../authority.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeReadFile,
  safeWriteFile,
} from '../secure-io.js';

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
  // Cached content must never bypass the current caller's permissions on an
  // explicit path populated by a more privileged request in this process.
  const explicitPath = getRegisteredEnvText('KYBERION_TOOL_RUNTIME_POLICY_PATH')?.trim();
  if (explicitPath) safeReadFile(policyPath, { encoding: 'utf8' });
  if (cachedPolicyPath === policyPath && cachedPolicy) return cachedPolicy;

  // Explicit paths retain the caller's permissions. The shared reader only
  // opens the canonical policy and the configured operator/customer overlay.
  cachedPolicy = explicitPath
    ? policyCatalog.load()
    : withExecutionContext('tool_runtime_policy_reader', () => policyCatalog.load());
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

/**
 * Directory under the managed root holding one subdirectory per tool runtime
 * (`<tool_runtime_root>/tool-runtimes/<runtime-dir>/`). Registry records spell
 * it in `managed_env_subpath`; code that builds the path itself uses this.
 */
export const TOOL_RUNTIMES_DIRNAME = 'tool-runtimes';

/**
 * Repo-relative download-cache root for managed tool runtimes:
 * `active/shared/cache/system/tool-runtimes`. It holds re-generable package and
 * model downloads (uv / pip / XDG caches, `HF_HOME`) keyed by runtime dir. Never
 * an install target.
 */
export const TOOL_RUNTIME_DOWNLOAD_CACHE_ROOT = storageFloorRelativePath(
  'cache',
  SYSTEM_PARTITION,
  TOOL_RUNTIMES_DIRNAME
);

/**
 * Canonical install root for every managed tool runtime (venvs, binaries,
 * `state.json` with install/pin provenance): `<tool_runtime_root>/tool-runtimes`,
 * i.e. `active/shared/runtime/tool-runtimes` under the governed policy. It stays
 * on the durable runtime floor because installs are approval-gated and their
 * files keep upstream mtimes, which the cache floor's per-file mtime TTL would
 * tear apart (see storage-retention-catalog.json).
 */
export function resolveToolRuntimesRoot(
  policy: ToolRuntimePolicy = getToolRuntimePolicy()
): string {
  return path.join(resolveToolRuntimeRoot(policy), TOOL_RUNTIMES_DIRNAME);
}

/** Absolute download-cache directory for one runtime (uv / pip / XDG / HF caches). */
export function resolveToolRuntimeDownloadCacheDir(runtimeDir: string): string {
  return resolveStorageFloor('cache', SYSTEM_PARTITION, TOOL_RUNTIMES_DIRNAME, runtimeDir);
}
