import type { KnowledgeTier } from '../foundation/knowledge-tier.js';

/** Asset attribution, independent of execution ScopeEnvelope and never a grant. */
export interface AssetCustody {
  readonly kind: 'system' | 'tenant' | 'person';
  readonly ref: string;
}

/** Structural view of the schema-validated store catalog; no filesystem access. */
export interface AssetStoreDeclaration {
  readonly id: string;
  readonly path: string;
  readonly custody: {
    readonly kind: AssetCustody['kind'] | 'derived' | 'unscoped-legacy';
    readonly ref?: string;
    readonly shared_segment?: 'system';
  };
  readonly tiers?: readonly KnowledgeTier[];
  readonly status: 'active' | 'planned' | 'legacy-move';
  readonly moves_to?: string;
}

export interface AssetAddress {
  readonly path: string;
  /** Physical store; retained even when its replacement is known. */
  readonly store: string;
  readonly location: AssetStoreDeclaration['status'];
  readonly movesTo?: string;
  readonly custody: AssetCustody;
  readonly tier: KnowledgeTier;
}

export type AssetAddressResolution =
  | { readonly status: 'resolved'; readonly address: AssetAddress }
  | {
      readonly status: 'unresolved';
      readonly reason:
        | 'invalid_path'
        | 'unknown_store'
        | 'ambiguous_store'
        | 'invalid_partition'
        | 'custody_unresolved'
        | 'tier_unresolved';
      readonly stores: readonly string[];
    };

/** Server-resolved ceiling for diagnostics only; does not confer any authority. */
export interface AssetReadCeiling {
  readonly custodians: readonly AssetCustody[];
  readonly readTiers: readonly KnowledgeTier[];
}

export interface AssetScopeObservation {
  readonly allowed: boolean;
  readonly reason: 'within_ceiling' | 'custody_denied' | 'tier_denied' | 'planned_location';
}
