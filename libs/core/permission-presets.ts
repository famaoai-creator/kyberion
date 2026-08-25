/** DH-11: named permission bundles are data; custom is derived, never stored. */

import { defineCatalog } from './foundation/governed-catalog.js';
import { pathResolver } from './path-resolver.js';
import type { ProviderPermissionProfileName } from './provider-permission-profiles.js';
import { resolveSandboxPolicy, type SandboxMode, type SandboxPolicy } from './sandbox-policy.js';

export type PermissionPresetName = 'readonly' | 'edit' | 'full';
export type ApprovalPolicy = 'strict' | 'relaxed' | 'plan';

export interface PermissionPreset {
  name: PermissionPresetName;
  sandbox_mode: SandboxMode;
  approval_policy: ApprovalPolicy;
  capability_profile: ProviderPermissionProfileName;
}

export interface ResolvedPermissionPreset extends Omit<PermissionPreset, 'name'> {
  name: PermissionPresetName | 'custom';
  derived: boolean;
  sandbox: SandboxPolicy;
}

interface PresetRegistryFile {
  version: number;
  presets: Record<PermissionPresetName, Omit<PermissionPreset, 'name'>>;
}

const REGISTRY_PATH = pathResolver.rootResolve(
  'knowledge/product/governance/permission-presets.json'
);
const registryCatalog = defineCatalog<PresetRegistryFile>({
  id: 'permission-presets',
  path: REGISTRY_PATH,
  schema: pathResolver.knowledge('product/schemas/permission-presets.schema.json'),
});

function readRegistry(): PresetRegistryFile {
  try {
    const candidate = registryCatalog.load();
    if (candidate.version !== 1) {
      throw new Error(`[PERMISSION_PRESET_REGISTRY] unsupported registry: ${REGISTRY_PATH}`);
    }
    return candidate;
  } catch (error) {
    if (error instanceof Error && error.message.includes('unsupported registry')) throw error;
    throw new Error(`[PERMISSION_PRESET_REGISTRY] invalid or missing registry: ${REGISTRY_PATH}`, {
      cause: error,
    });
  }
}

function buildResolved(
  name: PermissionPresetName | 'custom',
  input: Omit<PermissionPreset, 'name'>,
  derived: boolean
): ResolvedPermissionPreset {
  return {
    name,
    ...input,
    derived,
    sandbox: resolveSandboxPolicy({ mode: input.sandbox_mode }),
  };
}

/** Resolve only a registered named preset. `custom` is intentionally rejected. */
export function resolvePermissionPreset(name: string): ResolvedPermissionPreset {
  const normalized = name.trim() as PermissionPresetName;
  if (normalized !== 'readonly' && normalized !== 'edit' && normalized !== 'full') {
    throw new Error(`[PERMISSION_PRESET_UNKNOWN] named preset is not registered: ${name}`);
  }
  const input = readRegistry().presets[normalized];
  if (!input) throw new Error(`[PERMISSION_PRESET_REGISTRY] missing preset: ${normalized}`);
  return buildResolved(normalized, input, false);
}

/** Derive a custom bundle from independent knobs without persisting its name. */
export function derivePermissionPreset(input: {
  sandbox_mode: SandboxMode;
  approval_policy: ApprovalPolicy;
  capability_profile: ProviderPermissionProfileName;
}): ResolvedPermissionPreset {
  const registry = readRegistry();
  for (const name of ['readonly', 'edit', 'full'] as const) {
    const candidate = registry.presets[name];
    if (
      candidate.sandbox_mode === input.sandbox_mode &&
      candidate.approval_policy === input.approval_policy &&
      candidate.capability_profile === input.capability_profile
    ) {
      return buildResolved(name, input, false);
    }
  }
  return buildResolved('custom', input, true);
}

export function resetPermissionPresetRegistryCache(): void {
  registryCatalog.reset();
}
