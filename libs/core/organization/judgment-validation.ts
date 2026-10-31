/** Pure applicability checks. Semantic evidence does not authorize or execute an effect. */
import { canonicalJson } from '../decision-ledger/model.js';
import type { ScopeContext } from '../scope-context-validation.js';
import {
  judgmentBindingSchema,
  judgmentScopeSchema,
  parseJudgmentModelInput,
  parseSemanticVerdict,
  type DecisionEvidenceRef,
  type JudgmentAssessment,
  type JudgmentModelInput,
  type JudgmentUnavailableReason,
  type LatencyProposalFacts,
  type SemanticVerdict,
} from './judgment-contract.js';
import {
  createJudgmentPrecedentSnapshot,
  judgmentCanonicalHash,
  type JudgmentPrecedentResult,
  type JudgmentPrecedentSnapshot,
} from './judgment-precedents.js';

type Unavailable = Extract<JudgmentAssessment, { status: 'unavailable' }>;
const unavailable = (reason: JudgmentUnavailableReason, detail: string): Unavailable => ({
  status: 'unavailable',
  reason,
  detail,
});
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function sortedInput(input: unknown): JudgmentModelInput {
  // Check the original object before Zod normalization can erase exotic properties.
  judgmentCanonicalHash(input);
  const parsed = parseJudgmentModelInput(input);
  return {
    ...parsed,
    goals: [...parsed.goals].sort((a, b) => compare(a.goal_key, b.goal_key)),
    precedents: [...parsed.precedents].sort((a, b) => compare(a.source_key, b.source_key)),
    evidence: [...parsed.evidence].sort((a, b) => compare(a.evidence_key, b.evidence_key)),
  };
}

/** Shared hashing convention: these three keyed arrays are sets; their text is preserved. */
export function judgmentModelInputHashes(input: unknown): {
  request_hash: string;
  evidence_hash: string;
} {
  const normalized = sortedInput(input);
  return {
    request_hash: judgmentCanonicalHash(normalized),
    evidence_hash: judgmentCanonicalHash(normalized.evidence),
  };
}

/** Only structured, version-bound goal facts become precedent summaries. No raw ledger text. */
export function buildJudgmentModelInput(
  snapshot: JudgmentPrecedentSnapshot,
  proposal: LatencyProposalFacts,
  evidence: JudgmentModelInput['evidence']
): JudgmentModelInput {
  judgmentCanonicalHash(snapshot);
  const goals = [...snapshot.goals].sort((a, b) => compare(a.goal_key, b.goal_key));
  return sortedInput({
    goals,
    precedents: snapshot.evidence_refs.map((ref) => ({
      source_key: ref.source_key,
      summary: canonicalJson(goals.filter((goal) => goal.decision_source_key === ref.source_key)),
    })),
    proposal,
    evidence,
  });
}

function verifySnapshot(snapshot: JudgmentPrecedentSnapshot): JudgmentPrecedentResult {
  try {
    judgmentCanonicalHash(snapshot);
    const expectedFields = [
      'decisions',
      'evidence_refs',
      'goals',
      'scope',
      'scope_hash',
      'snapshot_hash',
    ];
    if (canonicalJson(Object.keys(snapshot).sort(compare)) !== canonicalJson(expectedFields)) {
      return unavailable('invalid_schema', 'Snapshot contains unsupported fields');
    }
    const caseIds = [...new Set(snapshot.decisions.map(({ record }) => record.case_id))];
    const rebuilt = createJudgmentPrecedentSnapshot(
      {
        scope: snapshot.scope,
        selected_case_ids: caseIds,
        allowed_case_ids: caseIds,
      },
      {
        resolveCaseBinding: (_tenant, caseId) => ({ case_id: caseId, scope: snapshot.scope }),
        readLedger: ({ caseId }) =>
          snapshot.decisions
            .filter(({ record }) => record.case_id === caseId)
            .map(({ record }) => record),
        resolveGoals: (source) => {
          const ref = snapshot.evidence_refs.find(
            (entry) =>
              entry.source_key === source.source_key &&
              entry.case_id === source.case_id &&
              entry.decision_id === source.decision_id &&
              entry.decision_version_hash === source.decision_version_hash
          );
          if (!ref) throw new Error('Decision reference does not match its versioned record');
          return snapshot.goals
            .filter((goal) => goal.decision_source_key === source.source_key)
            .map((goal) => {
              const { decision_source_key: _sourceKey, ...constraints } = goal;
              return {
                case_id: source.case_id,
                decision_id: source.decision_id,
                decision_version_hash: source.decision_version_hash,
                constraints,
              };
            });
        },
      }
    );
    if (rebuilt.status === 'unavailable') return rebuilt;
    if (judgmentCanonicalHash(snapshot) !== judgmentCanonicalHash(rebuilt.snapshot)) {
      return unavailable(
        'stale_precedent',
        'Snapshot contents or references no longer match their hashes'
      );
    }
    return rebuilt;
  } catch {
    return unavailable('invalid_schema', 'Snapshot integrity could not be verified');
  }
}

export interface JudgmentContextInput {
  /** Candidate binding and freshly recomputed binding are both server-owned, never model data. */
  binding: unknown;
  expectedBinding: unknown;
  scope: ScopeContext;
  modelInput: unknown;
  /** Both snapshots must originate in the caller-owned trusted reader, not model output. */
  snapshot: JudgmentPrecedentSnapshot;
  currentSnapshot: JudgmentPrecedentResult;
  requiredGoalKeys: readonly string[];
  /** Known synthetic candidates supplied by the trusted adapter; never an authority grant. */
  knownProposalKeys: readonly string[];
}
export type JudgmentContextResult =
  | { status: 'valid'; modelInput: JudgmentModelInput; snapshot: JudgmentPrecedentSnapshot }
  | Unavailable;
export type JudgmentValidationResult =
  { status: 'valid'; verdict: SemanticVerdict; evidence_refs: DecisionEvidenceRef[] } | Unavailable;

/** Preflight without a fabricated verdict, so malformed context consumes no model budget. */
export function checkJudgmentContext(input: JudgmentContextInput): JudgmentContextResult {
  try {
    judgmentCanonicalHash(input.binding);
    judgmentCanonicalHash(input.expectedBinding);
    judgmentCanonicalHash(input.scope);
    const binding = judgmentBindingSchema.parse(input.binding);
    const expected = judgmentBindingSchema.parse(input.expectedBinding);
    const scope = judgmentScopeSchema.parse(input.scope);
    const modelInput = sortedInput(input.modelInput);
    const scopeHash = judgmentCanonicalHash(scope);
    if (binding.scope_hash !== scopeHash || expected.scope_hash !== scopeHash) {
      return unavailable('scope_mismatch', 'Binding does not match the exact requested scope');
    }
    if (judgmentCanonicalHash(binding) !== judgmentCanonicalHash(expected)) {
      return unavailable(
        'stale_precedent',
        'Work, policy, model configuration or other binding fields changed'
      );
    }
    const initial = verifySnapshot(input.snapshot);
    if (initial.status === 'unavailable') return initial;
    if (input.currentSnapshot.status === 'unavailable') {
      return unavailable(input.currentSnapshot.reason, 'Current precedent evidence is unavailable');
    }
    const current = verifySnapshot(input.currentSnapshot.snapshot);
    if (current.status === 'unavailable') return current;
    for (const snapshot of [initial.snapshot, current.snapshot]) {
      if (snapshot.scope_hash !== scopeHash)
        return unavailable('scope_mismatch', 'Precedent scope differs from requested scope');
    }
    if (
      binding.precedent_snapshot_hash !== initial.snapshot.snapshot_hash ||
      initial.snapshot.snapshot_hash !== current.snapshot.snapshot_hash
    ) {
      return unavailable('stale_precedent', 'Current precedent snapshot changed after binding');
    }
    const hashes = judgmentModelInputHashes(modelInput);
    if (
      binding.request_hash !== hashes.request_hash ||
      binding.evidence_hash !== hashes.evidence_hash
    ) {
      return unavailable(
        'invalid_schema',
        'Model request or observation evidence changed after binding'
      );
    }
    const required = input.requiredGoalKeys;
    if (
      !Array.isArray(required) ||
      required.length === 0 ||
      required.length > 10 ||
      required.some(
        (key) => typeof key !== 'string' || !key || key !== key.trim() || key.length > 128
      ) ||
      new Set(required).size !== required.length ||
      canonicalJson([...required].sort(compare)) !==
        canonicalJson(initial.snapshot.goals.map((goal) => goal.goal_key))
    ) {
      return unavailable(
        'missing_evidence',
        'Required goals must exactly cover the trusted snapshot'
      );
    }
    const trustedInput = buildJudgmentModelInput(
      initial.snapshot,
      modelInput.proposal,
      modelInput.evidence
    );
    if (judgmentCanonicalHash(modelInput) !== judgmentCanonicalHash(trustedInput)) {
      return unavailable(
        'missing_evidence',
        'Model goals or precedent summaries differ from trusted evidence'
      );
    }
    if (modelInput.evidence.length === 0)
      return unavailable('missing_evidence', 'An observation is required');
    const known = input.knownProposalKeys;
    if (
      !Array.isArray(known) ||
      known.length === 0 ||
      known.length > 10 ||
      known.some(
        (key) => typeof key !== 'string' || !key || key !== key.trim() || key.length > 128
      ) ||
      new Set(known).size !== known.length ||
      !known.includes(modelInput.proposal.proposal_key)
    ) {
      return unavailable('missing_evidence', 'Proposal is not an established synthetic candidate');
    }
    for (const goal of initial.snapshot.goals) {
      const proposal = modelInput.proposal;
      if (
        proposal.service_key !== goal.service_key ||
        proposal.load_profile_hash !== goal.load_profile_hash ||
        proposal.currency !== goal.currency ||
        proposal.change_scope !== goal.permitted_change
      ) {
        return unavailable(
          'missing_evidence',
          'Proposal target, load profile or change conditions are incomparable'
        );
      }
    }
    return { status: 'valid', modelInput, snapshot: initial.snapshot };
  } catch {
    return unavailable('invalid_schema', 'Judgment context failed its strict bounded contract');
  }
}

/** Proves bounded structural applicability only, never performance or prose correctness. */
export function validateJudgment(
  input: JudgmentContextInput & { verdict: unknown }
): JudgmentValidationResult {
  const context = checkJudgmentContext(input);
  if (context.status === 'unavailable') return context;
  let verdict: SemanticVerdict;
  try {
    judgmentCanonicalHash(input.verdict);
    verdict = parseSemanticVerdict(input.verdict);
  } catch {
    return unavailable('invalid_schema', 'Model verdict failed its strict bounded contract');
  }
  const { snapshot, modelInput } = context;
  const sources = new Map(snapshot.evidence_refs.map((ref) => [ref.source_key, ref]));
  const proposal = modelInput.proposal;
  const unchangedGoal = snapshot.goals.every(
    (goal) =>
      proposal.requested_goal.target_users === goal.target_users &&
      proposal.requested_goal.max_p95_ms === goal.max_p95_ms
  );
  const newCost = snapshot.goals.some(
    (goal) => proposal.incremental_monthly_cost > goal.max_incremental_monthly_cost
  );
  if (verdict.disposition === 'apply_precedent') {
    if (verdict.precedent_keys.some((key) => !sources.has(key)))
      return unavailable('missing_evidence', 'Verdict cites an unknown precedent key');
    if (snapshot.goals.some((goal) => !verdict.precedent_keys.includes(goal.decision_source_key))) {
      return unavailable(
        'missing_evidence',
        'Precedent citations do not cover every required goal'
      );
    }
    if (!unchangedGoal || newCost)
      return unavailable(
        'missing_evidence',
        'Applying precedent would change an established target or cost constraint'
      );
    return {
      status: 'valid',
      verdict,
      evidence_refs: verdict.precedent_keys.map((key) => sources.get(key)!),
    };
  }
  if (verdict.disposition === 'reframe') {
    if (
      verdict.violated_goal_keys.some(
        (key) => !snapshot.goals.some((goal) => goal.goal_key === key)
      )
    ) {
      return unavailable('missing_evidence', 'Reframe cites an unknown original goal');
    }
    return {
      status: 'valid',
      verdict,
      evidence_refs: snapshot.evidence_refs.filter((ref) =>
        snapshot.goals.some(
          (goal) =>
            verdict.violated_goal_keys.includes(goal.goal_key) &&
            goal.decision_source_key === ref.source_key
        )
      ),
    };
  }
  if (!newCost || !unchangedGoal)
    return unavailable('missing_evidence', 'No supported new cost tradeoff is established');
  return { status: 'valid', verdict, evidence_refs: snapshot.evidence_refs };
}
