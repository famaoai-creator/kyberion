/**
 * promotion-lanes — per-kind promotion lanes for memory candidates.
 *
 * Every candidate used to require a steward's memory-approve; this module
 * classifies each candidate into a lane so only genuinely human-judgment
 * kinds wait on a person:
 *
 *   auto           — low-risk content that passed structural guards
 *                    (knowledge_hint by default): schema-valid, public tier,
 *                    no secret markers, bounded size.
 *   evidence_gated — self-ratifying by recurrence: N independently-queued
 *                    candidates for the same subject count as evidence
 *                    (the group's physical_record_count >= min_recurrence).
 *   pr_review      — the containing PR's review is the ratification
 *                    (sop_candidate, report_template): no separate steward
 *                    approval needed.
 *   steward        — reserved for sensitive scope: personal/confidential
 *                    tiers or any security/policy-touching candidate.
 */
import { readJsonIfPresent } from '../foundation/json.js';
import { pathResolver } from '../path-resolver.js';

export type PromotionLane = 'auto' | 'evidence_gated' | 'pr_review' | 'steward';
export type PromotionLaneKind =
  'pattern' | 'sop_candidate' | 'knowledge_hint' | 'report_template' | 'procedure';

export interface PromotionLanePolicy {
  version: string;
  lanes: Partial<Record<PromotionLaneKind, PromotionLane>>;
  auto_guards: {
    require_public_tier: boolean;
    forbidden_content_patterns: string[];
    max_summary_chars: number;
  };
  evidence_thresholds: { min_recurrence: number };
}

const POLICY_PATH = 'knowledge/product/governance/knowledge-promotion-policy.json';

const DEFAULT_POLICY: PromotionLanePolicy = {
  version: '1.0.0',
  lanes: {
    knowledge_hint: 'auto',
    pattern: 'evidence_gated',
    procedure: 'evidence_gated',
    sop_candidate: 'pr_review',
    report_template: 'pr_review',
  },
  auto_guards: {
    require_public_tier: true,
    forbidden_content_patterns: ['api[_-]?key', 'secret', 'token', 'password', 'credential'],
    max_summary_chars: 2000,
  },
  evidence_thresholds: { min_recurrence: 3 },
};

let policyCache: PromotionLanePolicy | undefined;
export function loadPromotionLanePolicy(rootDir?: string): PromotionLanePolicy {
  if (policyCache && !rootDir) return policyCache;
  const parsed = readJsonIfPresent<Partial<PromotionLanePolicy>>(
    `${rootDir ?? pathResolver.rootDir()}/${POLICY_PATH}`
  );
  const policy: PromotionLanePolicy = parsed
    ? {
        version: parsed.version ?? DEFAULT_POLICY.version,
        lanes: { ...DEFAULT_POLICY.lanes, ...(parsed.lanes ?? {}) },
        auto_guards: { ...DEFAULT_POLICY.auto_guards, ...(parsed.auto_guards ?? {}) },
        evidence_thresholds: {
          ...DEFAULT_POLICY.evidence_thresholds,
          ...(parsed.evidence_thresholds ?? {}),
        },
      }
    : DEFAULT_POLICY;
  if (!rootDir) policyCache = policy;
  return policy;
}
/** test seam */
export function resetPromotionLanePolicyCache(): void {
  policyCache = undefined;
}

export interface LaneSubject {
  target_kind?: string;
  tier?: string;
  title?: string;
  summary?: string;
  scope?: { tier?: string };
  metadata?: Record<string, unknown>;
}

/** Which lane a candidate travels. steward always wins over cheaper lanes. */
export function resolvePromotionLane(
  candidate: LaneSubject,
  policy: PromotionLanePolicy = loadPromotionLanePolicy()
): PromotionLane {
  const tier = candidate.tier ?? candidate.scope?.tier ?? 'public';
  if (tier === 'personal' || tier === 'confidential') return 'steward';
  const haystack = `${candidate.title ?? ''} ${candidate.summary ?? ''}`.toLowerCase();
  if (/(policy|security|permission|secret|tenant[_-]?scope)/.test(haystack)) return 'steward';
  return (
    policy.lanes[(candidate.target_kind as PromotionLaneKind) ?? 'knowledge_hint'] ?? 'steward'
  );
}

/** Structural guards for the auto lane — content shape, not judgment. */
export function autoLaneEligible(
  candidate: LaneSubject,
  policy: PromotionLanePolicy = loadPromotionLanePolicy()
): { eligible: boolean; reason?: string } {
  const g = policy.auto_guards;
  if (g.require_public_tier) {
    const tier = candidate.tier ?? candidate.scope?.tier ?? 'public';
    if (tier !== 'public') return { eligible: false, reason: `tier=${tier} is not public` };
  }
  const haystack = `${candidate.title ?? ''} ${candidate.summary ?? ''}`.toLowerCase();
  for (const pattern of g.forbidden_content_patterns) {
    if (new RegExp(pattern, 'i').test(haystack))
      return { eligible: false, reason: `forbidden pattern: ${pattern}` };
  }
  if ((candidate.summary ?? '').length > g.max_summary_chars)
    return { eligible: false, reason: 'summary exceeds max_summary_chars' };
  return { eligible: true };
}

/**
 * Effective approval requirement for a review group. `physicalRecordCount`
 * is the number of independently-queued candidates for the same subject —
 * the evidence the gated lane consumes.
 */
export function laneApprovesWithoutSteward(
  candidate: LaneSubject,
  physicalRecordCount: number,
  policy: PromotionLanePolicy = loadPromotionLanePolicy()
): { lane: PromotionLane; approves: boolean; reason?: string } {
  const lane = resolvePromotionLane(candidate, policy);
  if (lane === 'auto') {
    const check = autoLaneEligible(candidate, policy);
    return check.eligible
      ? { lane, approves: true }
      : { lane: 'steward', approves: false, reason: check.reason };
  }
  if (lane === 'evidence_gated') {
    const need = policy.evidence_thresholds.min_recurrence;
    return physicalRecordCount >= need
      ? { lane, approves: true, reason: `recurrence ${physicalRecordCount}/${need}` }
      : { lane, approves: false, reason: `recurrence ${physicalRecordCount}/${need}` };
  }
  return { lane, approves: false };
}
