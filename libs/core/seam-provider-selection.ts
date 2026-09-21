/**
 * Seam provider selection — which provider of a named seam runs this task
 * when several offer the same function with different capabilities and
 * traits (e.g. browser-automation-runtime: Chromium vs Lightpanda).
 *
 * Deterministic, in order:
 *   1. hard filter — the seam's caller marks each candidate eligible or not
 *      from what the task actually needs (capabilities are code truth);
 *   2. mission pin — a choice frozen earlier in the mission is reused;
 *   3. operator rule — a human-set preference for this purpose / context
 *      (seam-selection-rules.ts, usually set after a calibration run);
 *   4. purpose ranking — eligible providers are scored with the trait weights
 *      of the governed policy (one file per seam under
 *      knowledge/product/governance/seam-provider-selection/), using measured
 *      operator trait values where they exist;
 *   5. default — no purpose means the seam default; if the default cannot run
 *      the task, the policy's `fallback_purpose` ranks the eligible ones.
 * Every decision is written to the audit chain and, with a decision key
 * inside a mission, pinned so replays reproduce it.
 */

import { auditChain } from './audit-chain.js';
import {
  loadSeamProviderPin,
  pinSeamProviderDecision,
  type SeamPinnedEntry,
} from './provider-pins-store.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { pathResolver } from './path-resolver.js';
import { loadRegistryDirectory, type RegistryDirectoryOptions } from './registry-directory.js';
import {
  getSeamTraitOverrides,
  matchSeamSelectionRule,
  type SeamSelectionRule,
} from './seam-selection-rules.js';

export type SeamTraitBasis = 'measured' | 'declared';

export interface SeamProviderProfile {
  traits: Record<string, number>;
  trait_basis: Record<string, SeamTraitBasis>;
  evidence?: string[];
}

export interface SeamSelectionPurpose {
  description: string;
  weights: Record<string, number>;
}

export interface SeamSelectionPolicy {
  seam_id: string;
  default_provider: string;
  fallback_purpose?: string;
  traits: Record<string, string>;
  providers: Record<string, SeamProviderProfile>;
  purposes: Record<string, SeamSelectionPurpose>;
}

export interface SeamProviderCandidate {
  id: string;
  eligible: boolean;
  /** Why an ineligible candidate cannot run the task (capability names, ops, options). */
  unmet?: string[];
}

export interface SeamProviderScore {
  id: string;
  score: number;
  /** Trait contributions with their basis, e.g. `speed=0.6×1 (declared)`. */
  breakdown: string[];
}

export type SeamSelectionStrategy =
  'pinned' | 'rule' | 'purpose' | 'default' | 'fallback' | 'unresolved';

export interface SeamProviderDecision {
  seam: string;
  provider_id: string | null;
  /**
   * Every eligible provider, best first (the winner leads). Seams that run a
   * fallback chain walk this order instead of using only provider_id.
   */
  ranked: string[];
  strategy: SeamSelectionStrategy;
  purpose?: string;
  context?: Record<string, string>;
  rule_id?: string;
  eligible: string[];
  excluded: Array<{ id: string; unmet: string[] }>;
  scores: SeamProviderScore[];
  rationale: string;
  pinned: boolean;
  decision_key?: string;
}

export interface ResolveSeamProviderOptions {
  seam: string;
  candidates: SeamProviderCandidate[];
  purpose?: string;
  /** Request facts operator rules may match on, e.g. { language: 'ja' }. */
  context?: Record<string, string>;
  /** Stable logical slot; enables reuse of / pinning to a mission pin. */
  decisionKey?: string;
  /** Pin a fresh decision under decisionKey. Default: only inside a mission. */
  pin?: boolean;
  /** Record the decision to the audit chain. Default true. */
  record?: boolean;
  /** Ignore operator rules and measured overrides (calibration / explain baselines). */
  ignoreOperatorOverlay?: boolean;
}

const policyDirectoryOptions: RegistryDirectoryOptions = {
  id: 'seam-provider-selection-policy',
  dirPath: pathResolver.knowledge('product/governance/seam-provider-selection'),
  schemaPath: pathResolver.knowledge('product/schemas/seam-provider-selection-policy.schema.json'),
  arrayKey: 'seams',
  idKey: 'seam_id',
};

export function listSeamSelectionPolicies(): SeamSelectionPolicy[] {
  return loadRegistryDirectory<SeamSelectionPolicy>(policyDirectoryOptions).items;
}

export function getSeamSelectionPolicy(seam: string): SeamSelectionPolicy | null {
  return listSeamSelectionPolicies().find((policy) => policy.seam_id === seam) ?? null;
}

export function listSeamSelectionPurposes(seam: string): string[] {
  return Object.keys(getSeamSelectionPolicy(seam)?.purposes ?? {}).sort();
}

/** Product profiles with the operator's measured trait values applied. */
export function effectiveSeamProviderProfiles(
  policy: SeamSelectionPolicy,
  withOverrides = true
): Record<string, SeamProviderProfile> {
  const overrides = withOverrides ? getSeamTraitOverrides(policy.seam_id) : {};
  const ids = new Set([...Object.keys(policy.providers), ...Object.keys(overrides)]);
  const profiles: Record<string, SeamProviderProfile> = {};
  for (const id of ids) {
    const base = policy.providers[id] ?? { traits: {}, trait_basis: {} };
    const measured = overrides[id];
    if (!measured) {
      profiles[id] = base;
      continue;
    }
    const basis = { ...base.trait_basis };
    for (const trait of Object.keys(measured.traits)) basis[trait] = 'measured';
    profiles[id] = {
      traits: { ...base.traits, ...measured.traits },
      trait_basis: basis,
      evidence: [...(base.evidence ?? []), ...(measured.evidence ?? [])],
    };
  }
  return profiles;
}

function scoreCandidate(
  profiles: Record<string, SeamProviderProfile>,
  purpose: SeamSelectionPurpose,
  id: string
): SeamProviderScore {
  const profile = profiles[id];
  let score = 0;
  const breakdown: string[] = [];
  for (const [trait, weight] of Object.entries(purpose.weights).sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    const value = profile?.traits[trait] ?? 0;
    score += weight * value;
    const basis = profile ? (profile.trait_basis[trait] ?? 'declared') : 'unprofiled';
    breakdown.push(`${trait}=${weight}×${value} (${basis})`);
  }
  return { id, score: Math.round(score * 1000) / 1000, breakdown };
}

function actorId(): string {
  return (
    getRegisteredEnvText('KYBERION_PERSONA') ||
    getRegisteredEnvText('MISSION_ROLE') ||
    'seam-provider-selection'
  );
}

function recordDecision(decision: SeamProviderDecision): void {
  auditChain.record({
    agentId: actorId(),
    action: 'provider_selection',
    operation: `${decision.seam}/${decision.provider_id ?? 'unresolved'}`,
    result: decision.strategy === 'unresolved' ? 'error' : 'completed',
    reason: decision.rationale,
    metadata: {
      seam: decision.seam,
      provider_id: decision.provider_id,
      strategy: decision.strategy,
      purpose: decision.purpose,
      context: decision.context,
      rule_id: decision.rule_id,
      pinned: decision.pinned,
      decision_key: decision.decision_key,
      eligible: decision.eligible,
      excluded: decision.excluded,
      scores: decision.scores,
      ranked: decision.ranked,
    },
  });
}

function decide(
  options: ResolveSeamProviderOptions,
  pin: SeamPinnedEntry | null
): SeamProviderDecision {
  const { seam, purpose, decisionKey } = options;
  const context =
    options.context && Object.keys(options.context).length > 0 ? options.context : undefined;
  const policy = getSeamSelectionPolicy(seam);
  const eligible = options.candidates.filter((c) => c.eligible).map((c) => c.id);
  const excluded = options.candidates
    .filter((c) => !c.eligible)
    .map((c) => ({ id: c.id, unmet: c.unmet ?? [] }));
  const base = {
    seam,
    ...(purpose ? { purpose } : {}),
    ...(context ? { context } : {}),
    eligible,
    excluded,
    pinned: false,
    ...(decisionKey ? { decision_key: decisionKey } : {}),
  };
  const unresolved = (rationale: string): SeamProviderDecision => ({
    ...base,
    scores: [],
    provider_id: null,
    ranked: [],
    strategy: 'unresolved',
    rationale,
  });

  if (!policy) return unresolved(`no selection policy for seam '${seam}'`);
  if (eligible.length === 0) {
    const reasons = excluded.map((e) => `${e.id}: ${e.unmet.join(', ') || 'ineligible'}`);
    return unresolved(`no provider can run this task (${reasons.join('; ')})`);
  }
  const purposeSpec = purpose ? policy.purposes[purpose] : undefined;
  if (purpose && !purposeSpec) {
    return unresolved(
      `unknown purpose '${purpose}' for seam '${seam}' (known: ${Object.keys(policy.purposes).sort().join(', ')})`
    );
  }

  const withOverlay = !options.ignoreOperatorOverlay;
  const profiles = effectiveSeamProviderProfiles(policy, withOverlay);
  const defaultEligible = eligible.includes(policy.default_provider);
  // Without a purpose the default leads; if it cannot run the task the
  // policy's fallback purpose ranks what can.
  const rankingPurposeName =
    purpose ?? (!defaultEligible ? policy.fallback_purpose : undefined) ?? undefined;
  const rankingPurpose = rankingPurposeName ? policy.purposes[rankingPurposeName] : undefined;
  const tieBreak = (a: string, b: string) =>
    Number(b === policy.default_provider) - Number(a === policy.default_provider) ||
    a.localeCompare(b);
  const scores = rankingPurpose
    ? eligible
        .map((id) => scoreCandidate(profiles, rankingPurpose, id))
        .sort((a, b) => b.score - a.score || tieBreak(a.id, b.id))
    : [];
  const byPreference = rankingPurpose
    ? scores.map((score) => score.id)
    : [...eligible].sort(tieBreak);
  const withScores = { ...base, scores };
  const leading = (first: string[]) => [
    ...first,
    ...byPreference.filter((id) => !first.includes(id)),
  ];

  if (pin && eligible.includes(pin.provider_id)) {
    return {
      ...withScores,
      provider_id: pin.provider_id,
      ranked: leading([pin.provider_id]),
      strategy: 'pinned',
      pinned: true,
      rationale: `mission pin '${decisionKey}' (pinned ${pin.pinnedAt} by ${pin.by})`,
    };
  }
  const notes: string[] = [];
  if (pin) notes.push(`mission pin '${pin.provider_id}' cannot run this task`);

  const rule: SeamSelectionRule | null = withOverlay
    ? matchSeamSelectionRule(seam, { purpose, context })
    : null;
  if (rule) {
    const preferred = rule.prefer.filter((id) => eligible.includes(id));
    if (preferred.length > 0) {
      return {
        ...withScores,
        rule_id: rule.rule_id,
        provider_id: preferred[0]!,
        ranked: leading(preferred),
        strategy: 'rule',
        rationale:
          `operator rule '${rule.rule_id}' (set ${rule.set_at} by ${rule.set_by}) prefers ${rule.prefer.join(' > ')}` +
          (preferred.length < rule.prefer.length
            ? `; skipped ineligible ${rule.prefer.filter((id) => !preferred.includes(id)).join(', ')}`
            : '') +
          (notes.length ? `; ${notes.join('; ')}` : ''),
      };
    }
    notes.push(`operator rule '${rule.rule_id}' prefers only ineligible providers`);
  }
  const suffix = notes.length ? `; ${notes.join('; ')}` : '';

  if (!purposeSpec) {
    if (defaultEligible) {
      return {
        ...withScores,
        provider_id: policy.default_provider,
        ranked: leading([policy.default_provider]),
        strategy: 'default',
        rationale: `no purpose given; seam default '${policy.default_provider}'${suffix}`,
      };
    }
    if (!rankingPurpose) {
      return unresolved(
        `the seam default '${policy.default_provider}' cannot run this task and no purpose was given`
      );
    }
    const winner = scores[0]!;
    return {
      ...withScores,
      provider_id: winner.id,
      ranked: byPreference,
      strategy: 'fallback',
      rationale:
        `seam default '${policy.default_provider}' cannot run this task; fallback purpose ` +
        `'${rankingPurposeName}': ${winner.id} scored ${winner.score} [${winner.breakdown.join(', ')}]` +
        suffix,
    };
  }

  const winner = scores[0]!;
  const runnerUp = scores[1];
  return {
    ...withScores,
    provider_id: winner.id,
    ranked: byPreference,
    strategy: 'purpose',
    rationale:
      `purpose '${purpose}': ${winner.id} scored ${winner.score} [${winner.breakdown.join(', ')}]` +
      (runnerUp ? ` over ${runnerUp.id} ${runnerUp.score}` : ' (only eligible provider)') +
      (excluded.length ? `; excluded ${excluded.map((e) => e.id).join(', ')}` : '') +
      suffix,
  };
}

/** Choose a seam provider, then record and (inside a mission) pin the choice. */
export function resolveSeamProviderDecision(
  options: ResolveSeamProviderOptions
): SeamProviderDecision {
  const existingPin = options.decisionKey
    ? loadSeamProviderPin(options.seam, options.decisionKey)
    : null;
  const decision = decide(options, existingPin);
  const shouldPin = options.pin ?? Boolean(getRegisteredEnvText('MISSION_ID'));
  // An existing pin is never overwritten by a one-off fallback.
  if (
    options.decisionKey &&
    !existingPin &&
    shouldPin &&
    decision.provider_id &&
    decision.strategy !== 'unresolved'
  ) {
    pinSeamProviderDecision(
      options.seam,
      options.decisionKey,
      decision.provider_id,
      options.purpose
    );
    decision.pinned = true;
  }
  if (options.record !== false) recordDecision(decision);
  return decision;
}

/** Explain what would be chosen, without recording or pinning. */
export function explainSeamProviderDecision(
  options: Omit<ResolveSeamProviderOptions, 'record' | 'pin'>
): SeamProviderDecision {
  const existingPin = options.decisionKey
    ? loadSeamProviderPin(options.seam, options.decisionKey)
    : null;
  return decide(options, existingPin);
}
