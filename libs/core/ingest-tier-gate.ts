/**
 * DA-06 tier classification gate for the ingest ceremony.
 *
 * proposeTierPlacement is a PURE advisory function: it maps (source
 * ownership, PII findings) to a landing-root proposal. It never decides —
 * any placement outside the owning tenant's confidential root requires a
 * human steward approval through the KM-03 memory-promotion queue
 * (mirroring the KKP `promotion_approval_id` semantics of
 * wisdom-actuator's knowledge import). Auto-promotion is structurally
 * impossible: ingest:commit verifies the supplied `steward_approval_id`
 * against the queue and only 'approved'/'promoted' candidates whose
 * declared target root matches pass (fail-closed).
 *
 * Queue reuse: enqueueTierPromotionCandidate wraps the KM-03
 * memory-promotion-queue with a `tier_promotion:{target_root}:{asset_ref}`
 * source_ref. Evidence refs must be ledger provenance refs
 * (`asset:ing-…@v{n}`), not confidential file paths — the queue's
 * public-tier evidence guard rejects confidential paths on public
 * candidates by design.
 */

import type { PiiFinding } from './pii-scrubber.js';
import {
  createMemoryPromotionCandidate,
  enqueueMemoryPromotionCandidate,
  loadMemoryPromotionCandidate,
  type MemoryCandidate,
} from './memory-promotion-queue.js';
import { isValidTenantSlug } from './entity-scope.js';

/** Landing roots a steward can approve (anything else is unreachable). */
export const TIER_PROMOTION_TARGET_ROOTS = [
  'knowledge/confidential/common',
  'knowledge/public',
] as const;

export type TierPromotionTargetRoot = (typeof TIER_PROMOTION_TARGET_ROOTS)[number];

const TIER_PROMOTION_SOURCE_REF_PREFIX = 'tier_promotion:';

export interface TierPlacementInput {
  source_meta?: {
    source_system?: string;
    source_id?: string;
    /** Caller-asserted "this source is already public" flag — a proposal input, never a bypass. */
    explicitly_public?: boolean;
  };
  /** Owning tenant when the source is tenant-exclusive. */
  tenant_slug?: string;
  /** scanContent() findings over the normalized card text. */
  findings: PiiFinding[];
}

export interface TierPlacementProposal {
  proposed_path_root: string;
  rationale: string[];
  requires_steward_approval: boolean;
}

function fail(message: string): never {
  throw new Error(`[ingest-tier-gate] ${message}`);
}

/**
 * Pure tier-placement advisory. Tenant-owned sources stay in the tenant
 * root (no approval — DA-05 behavior unchanged); everything else lands in
 * confidential/common by default; a public proposal needs BOTH zero
 * findings and an explicit public-source assertion, and ANY placement
 * outside a tenant root requires steward approval.
 */
export function proposeTierPlacement(input: TierPlacementInput): TierPlacementProposal {
  const findings = Array.isArray(input?.findings) ? input.findings : [];
  const ruleIds = [...new Set(findings.map((finding) => finding.rule_id))].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0
  );
  const tenantSlug = String(input?.tenant_slug || '').trim();
  if (tenantSlug) {
    if (!isValidTenantSlug(tenantSlug)) fail(`invalid tenant_slug '${tenantSlug}'`);
    return {
      proposed_path_root: `knowledge/confidential/${tenantSlug}`,
      rationale: [
        `Source is tenant-owned ('${tenantSlug}') — it lands in the tenant's own confidential root.`,
        ...(ruleIds.length > 0
          ? [
              `PII/secret findings present (${ruleIds.join(', ')}) — tenant confidential is the only safe tier.`,
            ]
          : []),
      ],
      requires_steward_approval: false,
    };
  }
  if (ruleIds.length > 0) {
    return {
      proposed_path_root: 'knowledge/confidential/common',
      rationale: [
        `No owning tenant, but PII/secret findings present (${ruleIds.join(', ')}) — confidential/common, never public.`,
        'Landing in confidential/common requires steward approval (KM-03 queue).',
      ],
      requires_steward_approval: true,
    };
  }
  if (input?.source_meta?.explicitly_public === true) {
    return {
      proposed_path_root: 'knowledge/public',
      rationale: [
        'No owning tenant, zero PII/secret findings, and the source is asserted explicitly public.',
        'ANY public placement requires steward approval (KM-03 queue) — this is a proposal, not a decision.',
      ],
      requires_steward_approval: true,
    };
  }
  return {
    proposed_path_root: 'knowledge/confidential/common',
    rationale: [
      'No owning tenant and no explicit public-source assertion — defaulting to confidential/common (fail-closed).',
      'Landing in confidential/common requires steward approval (KM-03 queue).',
    ],
    requires_steward_approval: true,
  };
}

export interface TierPromotionCandidateInput {
  target_root: TierPromotionTargetRoot;
  /** Ledger provenance ref of the asset ('asset:ing-…@v{n}') or a stable source ref. */
  asset_ref: string;
  summary: string;
  /** Provenance refs, NOT confidential file paths (public-tier evidence guard). */
  evidence_refs: string[];
}

/**
 * Queue a tier-promotion candidate for steward review (KM-03 reuse). The
 * returned candidate_id is what a human steward approves; that id then
 * feeds ingest:commit as `steward_approval_id`.
 */
export function enqueueTierPromotionCandidate(input: TierPromotionCandidateInput): MemoryCandidate {
  const targetRoot = input?.target_root;
  if (!TIER_PROMOTION_TARGET_ROOTS.includes(targetRoot)) {
    fail(
      `target_root must be one of ${TIER_PROMOTION_TARGET_ROOTS.join(', ')} (got '${String(targetRoot)}')`
    );
  }
  const assetRef = String(input?.asset_ref || '').trim();
  if (!assetRef) fail('asset_ref is required (ledger provenance ref of the ingested asset)');
  const summary = String(input?.summary || '').trim();
  if (!summary) fail('summary is required (what the steward is asked to approve)');
  const candidate = createMemoryPromotionCandidate({
    sourceType: 'artifact',
    sourceRef: `${TIER_PROMOTION_SOURCE_REF_PREFIX}${targetRoot}:${assetRef}`,
    proposedMemoryKind: 'heuristic',
    summary: `[tier-promotion → ${targetRoot}] ${summary}`,
    evidenceRefs: input.evidence_refs,
    sensitivityTier: targetRoot === 'knowledge/public' ? 'public' : 'confidential',
    ratificationRequired: true,
  });
  enqueueMemoryPromotionCandidate(candidate);
  return candidate;
}

/**
 * Fail-closed steward-approval verification for ingest:commit. The id must
 * resolve to a queue candidate that (a) is a tier-promotion candidate,
 * (b) declares the SAME target root the commit is attempting, and (c) has
 * been ratified by a steward ('approved', or 'promoted' for supersede
 * re-ingests of an already-landed asset). Anything else throws.
 */
export function verifyStewardApproval(input: {
  approval_id: string;
  target_root: TierPromotionTargetRoot;
}): MemoryCandidate {
  const approvalId = String(input?.approval_id || '').trim();
  if (!approvalId) fail('steward approval id is required');
  const candidate = loadMemoryPromotionCandidate(approvalId);
  if (!candidate) {
    fail(`steward approval '${approvalId}' not found in the KM-03 promotion queue`);
  }
  const expectedPrefix = `${TIER_PROMOTION_SOURCE_REF_PREFIX}${input.target_root}:`;
  if (!candidate.source_ref.startsWith(expectedPrefix)) {
    fail(
      `steward approval '${approvalId}' does not authorize landing under '${input.target_root}' ` +
        `(candidate source_ref: '${candidate.source_ref}')`
    );
  }
  if (candidate.status !== 'approved' && candidate.status !== 'promoted') {
    fail(
      `steward approval '${approvalId}' has status '${candidate.status}' — ` +
        `a steward must approve it via the KM-03 queue before ingest can land there`
    );
  }
  return candidate;
}
