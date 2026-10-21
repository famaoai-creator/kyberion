/**
 * Projection brief (SD-05), pure. The decision ledger drawn as a canvas is
 * not model-generated: every row is derived from the ledger (decided and
 * open records), the latest observation of the implementation, and — while a
 * hearing is running — the answers given so far. The surface turns this brief
 * into HTML with the design-defaults cascade; nothing here knows about HTML.
 *
 * Verdicts on a row:
 *   decided rows carry the conformance verdict (match / conflict / stale /
 *   unprobed) against the observation set;
 *   open rows (proposed / observed / enacted / undecided) are `open`, and
 *   carry the hearing answer when one exists.
 */
import { checkConformance } from './conformance.js';
import type { LedgerHearingAnswer } from './hearing-scenario.js';
import type {
  DecisionLevel,
  DecisionObservedSet,
  DecisionRecord,
  DecisionState,
  DecisionVerdict,
} from './model.js';

export type ProjectionVerdict = DecisionVerdict | 'open';

export interface ProjectionRow {
  id: string;
  item: string;
  key: string;
  level: DecisionLevel;
  state: DecisionState;
  verdict: ProjectionVerdict;
  value: unknown;
  observed?: unknown;
  impl_ref?: string;
  pending_reason?: string;
  /** The hearing answer for an open row — given, not yet recorded. */
  answer?: string;
  basis_refs: string[];
  decided_by?: string;
}

export interface ProjectionBrief {
  case_id: string;
  actor?: 'product' | 'customer';
  rows: ProjectionRow[];
  tally: Record<ProjectionVerdict, number>;
  impl?: DecisionObservedSet['impl'];
  /** True when any decided row conflicts with, or is stale against, the implementation. */
  red: boolean;
  generated_at: string;
}

export interface ProjectionOptions {
  caseId: string;
  now: string;
  actor?: 'product' | 'customer';
  answers?: readonly LedgerHearingAnswer[];
}

const EMPTY_TALLY: Record<ProjectionVerdict, number> = {
  match: 0,
  conflict: 0,
  stale: 0,
  unprobed: 0,
  open: 0,
};

export function buildProjectionBrief(
  decisions: readonly DecisionRecord[],
  observed: DecisionObservedSet | undefined,
  options: ProjectionOptions
): ProjectionBrief {
  const active = decisions.filter(
    (item) =>
      item.status === 'active' && item.case_id === options.caseId && item.state !== 'rejected'
  );
  const report = checkConformance(active, observed, { now: options.now });
  const verdictById = new Map(report.checks.map((check) => [check.decision, check]));
  const answerById = new Map(
    (options.answers ?? [])
      .filter((item) => typeof item.answer === 'string' && item.answer.trim())
      .map((item) => [item.id, (item.answer as string).trim()])
  );
  const rows: ProjectionRow[] = active
    .filter((item) => {
      if (!options.actor) return true;
      const ask = item.level === 'customer-value' ? 'customer' : 'product';
      return item.state === 'decided' || ask === options.actor;
    })
    .map((item) => {
      const check = verdictById.get(item.id);
      const row: ProjectionRow = {
        id: item.id,
        item: item.item,
        key: item.key,
        level: item.level,
        state: item.state,
        verdict: item.state === 'decided' ? (check?.verdict ?? 'unprobed') : 'open',
        value: item.value,
        basis_refs: item.basis.map((basis) => basis.ref),
      };
      if (check?.observed !== undefined) row.observed = check.observed;
      if (check?.impl_ref) row.impl_ref = check.impl_ref;
      if (item.pending_reason) row.pending_reason = item.pending_reason;
      if (item.decided_by) row.decided_by = item.decided_by.id;
      const answer = answerById.get(item.id);
      if (item.state !== 'decided' && answer) row.answer = answer;
      return row;
    });
  const tally = { ...EMPTY_TALLY };
  for (const row of rows) tally[row.verdict] += 1;
  return {
    case_id: options.caseId,
    ...(options.actor ? { actor: options.actor } : {}),
    rows,
    tally,
    ...(observed ? { impl: observed.impl } : {}),
    red: tally.conflict > 0 || tally.stale > 0,
    generated_at: options.now,
  };
}
