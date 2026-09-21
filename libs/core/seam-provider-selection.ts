/**
 * Seam provider selection — which provider of a named seam runs this task
 * when several offer the same function with different capabilities and
 * traits (e.g. browser-automation-runtime: Chromium vs Lightpanda).
 *
 * Deterministic, in three steps:
 *   1. hard filter — the seam's caller marks each candidate eligible or not
 *      from what the task actually needs (capabilities are code truth);
 *   2. purpose ranking — the caller states a purpose ("evidence",
 *      "throughput", ...) and eligible providers are scored with the trait
 *      weights of the governed policy (one file per seam under
 *      knowledge/product/governance/seam-provider-selection/);
 *   3. record — the decision is written to the audit chain and, when a
 *      decision key is given inside a mission, pinned so replays reproduce it.
 *
 * No purpose means "the seam default": selection never silently moves a task
 * off the default provider unless the task asked for a purpose.
 */

import { auditChain } from './audit-chain.js';
import {
  loadSeamProviderPin,
  pinSeamProviderDecision,
  type SeamPinnedEntry,
} from './capability-broker.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { pathResolver } from './path-resolver.js';
import { loadRegistryDirectory, type RegistryDirectoryOptions } from './registry-directory.js';

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

export type SeamSelectionStrategy = 'pinned' | 'purpose' | 'default' | 'unresolved';

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
  /** Stable logical slot; enables reuse of / pinning to a mission pin. */
  decisionKey?: string;
  /** Pin a fresh decision under decisionKey. Default: only inside a mission. */
  pin?: boolean;
  /** Record the decision to the audit chain. Default true. */
  record?: boolean;
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

function scoreCandidate(
  policy: SeamSelectionPolicy,
  purpose: SeamSelectionPurpose,
  id: string
): SeamProviderScore {
  const profile = policy.providers[id];
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
  const policy = getSeamSelectionPolicy(seam);
  const eligible = options.candidates.filter((c) => c.eligible).map((c) => c.id);
  const excluded = options.candidates
    .filter((c) => !c.eligible)
    .map((c) => ({ id: c.id, unmet: c.unmet ?? [] }));
  const base = {
    seam,
    ...(purpose ? { purpose } : {}),
    eligible,
    excluded,
    scores: [] as SeamProviderScore[],
    pinned: false,
    ...(decisionKey ? { decision_key: decisionKey } : {}),
  };
  const unresolved = (rationale: string): SeamProviderDecision => ({
    ...base,
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
  // Eligible providers best-first: by purpose score, else seam default first;
  // ties go to the seam default, then id.
  const tieBreak = (a: string, b: string) =>
    Number(b === policy.default_provider) - Number(a === policy.default_provider) ||
    a.localeCompare(b);
  const scores = purposeSpec
    ? eligible
        .map((id) => scoreCandidate(policy, purposeSpec, id))
        .sort((a, b) => b.score - a.score || tieBreak(a.id, b.id))
    : [];
  const byPreference = purposeSpec ? scores.map((score) => score.id) : [...eligible].sort(tieBreak);
  const withScores = { ...base, scores };

  if (pin && eligible.includes(pin.provider_id)) {
    return {
      ...withScores,
      provider_id: pin.provider_id,
      ranked: [pin.provider_id, ...byPreference.filter((id) => id !== pin.provider_id)],
      strategy: 'pinned',
      pinned: true,
      rationale: `mission pin '${decisionKey}' (pinned ${pin.pinnedAt} by ${pin.by})`,
    };
  }
  const pinNote = pin ? `; mission pin '${pin.provider_id}' cannot run this task` : '';

  if (!purposeSpec) {
    return eligible.includes(policy.default_provider)
      ? {
          ...withScores,
          provider_id: policy.default_provider,
          ranked: byPreference,
          strategy: 'default',
          rationale: `no purpose given; seam default '${policy.default_provider}'${pinNote}`,
        }
      : unresolved(
          `the seam default '${policy.default_provider}' cannot run this task and no purpose was given`
        );
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
      pinNote,
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
    (decision.strategy === 'purpose' || decision.strategy === 'default')
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
