/**
 * Shared ranking signals (KM-02 Task 4).
 *
 * Two rankers coexist: scripts/context_ranker.ts (pipeline-facing document
 * ranking CLI) and libs/core/src/knowledge-index.ts (runtime retrieval).
 * Their scoring definitions historically lived inline in each, so a tuning
 * fix in one never reached the other. The formulas below are the single
 * source of truth; both rankers import them. Full unification (making the
 * CLI a wrapper over the runtime index) is recorded in the KM-02 plan as
 * the next step.
 */

/** Cross-scope affinity: how relevant an entry of scope X is when ranking for scope Y. */
export type ScopeAffinityMatrix = Record<string, Record<string, number>>;

export const DEFAULT_SCOPE_AFFINITY: ScopeAffinityMatrix = {
  global: { global: 1, repository: 0.6, mission: 0.4, environment: 0.2 },
  repository: { global: 0.7, repository: 1, mission: 0.8, environment: 0.3 },
  mission: { global: 0.5, repository: 0.8, mission: 1, environment: 0.4 },
  environment: { global: 0.3, repository: 0.4, mission: 0.5, environment: 1 },
};

/** Affinity used when either scope is unknown to the matrix. */
export const SCOPE_AFFINITY_FALLBACK = 0.4;

export function scopeAffinityScore(
  currentScope: string,
  entryScope: string,
  scopeWeight: number,
  matrix: ScopeAffinityMatrix = DEFAULT_SCOPE_AFFINITY
): number {
  const affinity = matrix[currentScope]?.[entryScope] ?? SCOPE_AFFINITY_FALLBACK;
  return Math.round(scopeWeight * affinity);
}

/**
 * Document-authority ladder. Offsets are subtracted from the configured
 * authority weight; every recognised level scores at least 1 so a governed
 * document never ties with an unclassified one.
 */
export const DOC_AUTHORITY_OFFSETS: Record<string, number> = {
  policy: 0,
  standard: 1,
  recipe: 2,
  reference: 4,
  advisory: 5,
};

export function docAuthorityScore(docAuthority: string, authorityWeight: number): number {
  const offset = DOC_AUTHORITY_OFFSETS[docAuthority];
  if (offset === undefined) return 0;
  return offset === 0 ? authorityWeight : Math.max(1, authorityWeight - offset);
}

export interface RecencyDecayOptions {
  /** Score when the document was updated just now. Default 10. */
  maxScore?: number;
  /** Days it takes to lose one point. Default 30 (~1 point per month). */
  decayDaysPerPoint?: number;
}

export function recencyDecayScore(
  lastUpdatedMs: number,
  nowMs: number,
  options: RecencyDecayOptions = {}
): number {
  const maxScore = options.maxScore ?? 10;
  const decayDaysPerPoint = options.decayDaysPerPoint ?? 30;
  if (!Number.isFinite(lastUpdatedMs)) return 0;
  const daysSince = Math.max(0, (nowMs - lastUpdatedMs) / (1000 * 60 * 60 * 24));
  return Math.max(0, maxScore - daysSince / decayDaysPerPoint);
}
