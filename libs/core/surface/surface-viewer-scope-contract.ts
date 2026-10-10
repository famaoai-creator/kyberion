/** Pure viewer identity, scope, and error contracts shared by surface adapters. */
import type { ChronosAccessRole } from '../chronos-access-registry.js';
import type { OsKnowledgeTier } from '../cloudflare-os-control-plane.js';

/** Opt-in human ownership namespace. Authentication evidence stays transport-owned. */
export interface CanonicalHumanRequestIdentity {
  version: 1;
  authorityNamespace: string;
  memberId: string;
  /** Deterministic snapshot of current member tenant-role restrictions. */
  membershipFingerprint: string;
}

/** Framework-neutral viewer scope shared by HTTP surfaces. */
export interface SurfaceViewerScope {
  role: ChronosAccessRole;
  tenantSlugs: string[] | 'all';
  organizationIds: string[] | 'all';
  projectIds: string[] | 'all';
  tierAccess: OsKnowledgeTier[];
  source: 'token' | 'loopback' | 'anonymous';
  principalId?: string;
  /** FD-07: the matched registration's `label`, when a token registration matched. */
  registrationLabel?: string;
  /** FD-07: the matched registration's `member_id`, when it declares one. */
  memberId?: string;
  /** Only a strict, freshly resolved verified-human adapter may opt into this namespace. */
  canonicalHuman?: CanonicalHumanRequestIdentity;
}

export class SurfaceViewerScopeError extends Error {
  constructor(
    public readonly status: 401 | 403,
    message: string
  ) {
    super(message);
    this.name = 'SurfaceViewerScopeError';
  }
}
