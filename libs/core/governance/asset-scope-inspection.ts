import * as path from 'node:path';
import type {
  AssetAddressResolution,
  AssetReadCeiling,
  AssetScopeObservation,
  AssetStoreDeclaration,
} from '../contracts/asset-scope.js';
import { resolveAssetAddress, observeAssetReadCeiling } from '../foundation/asset-address.js';
import { defineCatalog } from '../foundation/governed-catalog.js';
import { pathResolver } from '../path-resolver.js';
import { policyRelativePath } from '../policy-relative-path.js';
import { inspectReadPermission, type ReadPermissionDecision } from '../tier-guard.js';

function loadStores(): readonly AssetStoreDeclaration[] {
  return defineCatalog<{ stores: AssetStoreDeclaration[] }>({
    id: 'asset-scope-stores',
    path: () => pathResolver.knowledge('product/governance/store-catalog.json'),
    schema: pathResolver.knowledge('product/schemas/store-catalog.schema.json'),
  }).load().stores;
}

export interface AssetScopeReadInspection {
  /** The sole authoritative result. Shadow evaluation cannot replace this. */
  readonly decision: ReadPermissionDecision;
  readonly shadow:
    | { readonly status: 'unavailable' }
    | { readonly status: 'unresolved'; readonly resolution: AssetAddressResolution }
    | { readonly status: 'address_only'; readonly resolution: AssetAddressResolution }
    | {
        readonly status: 'compared';
        readonly resolution: AssetAddressResolution;
        readonly observation: AssetScopeObservation;
        /** Boolean agreement with the ceiling only, not full authorization equivalence. */
        readonly agrees: boolean;
      };
}

/** Explicit policy/address inspection outside tier-guard/secure-io; not a complete I/O check.
 * Omitted ceilings report attribution only and never infer authority from the address. */
export function inspectAssetScopeRead(
  filePath: string,
  ceiling?: AssetReadCeiling,
  options: {
    operation?: 'read' | 'metadata';
    /** Server-owned test/composition seams, never populated from HTTP request input. */
    inspect?: typeof inspectReadPermission;
    loadStores?: () => readonly AssetStoreDeclaration[];
  } = {}
): AssetScopeReadInspection {
  const decision = (options.inspect ?? inspectReadPermission)(
    filePath,
    options.operation ?? 'read'
  );
  try {
    const relative = policyRelativePath(path.resolve(filePath));
    const resolution = resolveAssetAddress(relative, (options.loadStores ?? loadStores)());
    if (resolution.status === 'unresolved')
      return { decision, shadow: { status: 'unresolved', resolution } };
    if (ceiling === undefined) return { decision, shadow: { status: 'address_only', resolution } };
    const observation = observeAssetReadCeiling(resolution.address, ceiling);
    return {
      decision,
      shadow: {
        status: 'compared',
        resolution,
        observation,
        agrees: decision.allowed === observation.allowed,
      },
    };
  } catch {
    return { decision, shadow: { status: 'unavailable' } };
  }
}
