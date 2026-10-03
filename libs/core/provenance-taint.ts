import type {
  ObservationRecord,
  OsKnowledgeTier,
  ProvenanceTaint,
} from './cloudflare-os-control-plane.js';

const TIER_RANK: Record<OsKnowledgeTier, number> = {
  public: 0,
  confidential: 1,
  personal: 2,
};

export interface ProvenanceShareCheck {
  provenance: ProvenanceTaint | null | undefined;
  audienceFloor: OsKnowledgeTier;
  targetTenant?: string;
  external: boolean;
}

export class ProvenanceTaintPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProvenanceTaintPolicyError';
  }
}

export function projectProvenanceTaint(
  missionId: string,
  observations: readonly ObservationRecord[]
): ProvenanceTaint {
  const missionObservations = observations.filter((entry) => entry.missionId === missionId);
  const highestTier = missionObservations.reduce<OsKnowledgeTier>(
    (current, entry) => (TIER_RANK[entry.tier] > TIER_RANK[current] ? entry.tier : current),
    'public'
  );
  return {
    missionId,
    highestTier,
    tenants: [
      ...new Set(
        missionObservations
          .map((entry) => entry.tenantSlug)
          .filter((tenant): tenant is string => Boolean(tenant && tenant.trim()))
      ),
    ].sort(),
    prohibitExternal: missionObservations.some((entry) => entry.tier !== 'public'),
    observationIds: missionObservations.map((entry) => entry.id),
  };
}

export function combineProvenanceTaint(
  declaredTaint: OsKnowledgeTier,
  provenance: ProvenanceTaint | null | undefined
): OsKnowledgeTier {
  if (!provenance) return declaredTaint;
  return TIER_RANK[provenance.highestTier] > TIER_RANK[declaredTaint]
    ? provenance.highestTier
    : declaredTaint;
}

export function assertProvenanceShareAllowed(check: ProvenanceShareCheck): void {
  const provenance = check.provenance;
  if (!provenance) return;

  if (TIER_RANK[check.audienceFloor] < TIER_RANK[provenance.highestTier]) {
    throw new ProvenanceTaintPolicyError(
      `[POLICY_VIOLATION] audience floor ${check.audienceFloor} is broader than provenance taint ${provenance.highestTier}`
    );
  }
  if (check.external && provenance.prohibitExternal) {
    throw new ProvenanceTaintPolicyError(
      '[POLICY_VIOLATION] external sharing is prohibited for non-public provenance'
    );
  }
  if (provenance.tenants.length > 0) {
    if (!check.targetTenant || !provenance.tenants.includes(check.targetTenant)) {
      throw new ProvenanceTaintPolicyError(
        `[POLICY_VIOLATION] target tenant is outside provenance scope for mission ${provenance.missionId}`
      );
    }
  }
}

export interface ProvenanceEgressVerdict {
  allowed: boolean;
  reason?: string;
}

/**
 * SC-06: the single provenance-egress decision — control-plane
 * `assertEgressAllowed` and the op-level egress guard share this so the
 * tier/tenant rules are never implemented twice.
 *
 * Rules (all deny-driven):
 * - `external` audience is always denied — brokered service egress
 *   declares a concrete target, never the raw external audience.
 * - a tainted mission cannot egress to a tenant outside its observed set.
 * - a tainted mission cannot egress to a tier below its highest observed.
 */
export function evaluateProvenanceEgress(
  taint: ProvenanceTaint,
  targetAudience: OsKnowledgeTier | 'external',
  targetTenant?: string
): ProvenanceEgressVerdict {
  if (targetAudience === 'external') {
    return { allowed: false, reason: 'external audience is always denied' };
  }
  const missingTenant = taint.tenants.length > 0 && !targetTenant;
  const wrongTenant = Boolean(
    targetTenant && taint.tenants.length > 0 && !taint.tenants.includes(targetTenant)
  );
  if (missingTenant || wrongTenant) {
    return {
      allowed: false,
      reason: `tenant ${targetTenant ?? '(none)'} outside observed tenants [${taint.tenants.join(',')}]`,
    };
  }
  if (TIER_RANK[targetAudience] < TIER_RANK[taint.highestTier]) {
    return {
      allowed: false,
      reason: `audience ${targetAudience} below taint tier ${taint.highestTier}`,
    };
  }
  return { allowed: true };
}
