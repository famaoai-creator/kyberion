/**
 * Decision ledger conformance (SD-00 / SD-06): active `decided` records × what an
 * observer extracted from an implementation → per-key verdict, a report,
 * and the lock file an implementation repository commits and re-checks in
 * CI. Pure — observers (the code that reads a repository) live outside this
 * module and hand in an {@link DecisionObservedSet}.
 *
 * Verdicts:
 *   match     the observed value equals the decided value (canonical JSON)
 *   conflict  it does not
 *   stale     the observer flagged the observed value as coming from a
 *             superseded source, even if it happens to equal
 *   unprobed  no observation exists for the key — shown, never hidden
 *
 * `comparators` lets a caller override equality for one key (e.g. treat two
 * charset spellings as one) without teaching this module any domain.
 */
import {
  canonicalJson,
  type DecisionConformanceCheck,
  type DecisionConformanceReport,
  type DecisionRecord,
  type DecisionLock,
  type DecisionObservedSet,
  type DecisionVerdict,
} from './model.js';

export type DecisionComparator = (decided: unknown, observed: unknown) => boolean;

export interface DecisionConformanceOptions {
  now: string;
  comparators?: Record<string, DecisionComparator>;
}

export function activeDecided(decisions: readonly DecisionRecord[]): DecisionRecord[] {
  return decisions.filter((item) => item.status === 'active' && item.state === 'decided');
}

export function checkConformance(
  decisions: readonly DecisionRecord[],
  observed: DecisionObservedSet | undefined,
  options: DecisionConformanceOptions
): DecisionConformanceReport {
  const byKey = new Map((observed?.observations ?? []).map((item) => [item.key, item]));
  const checks: DecisionConformanceCheck[] = activeDecided(decisions).map((decision) => {
    const seen = byKey.get(decision.key);
    if (!seen) {
      return {
        decision: decision.id,
        item: decision.item,
        key: decision.key,
        verdict: 'unprobed',
        why: 'no observation for this key',
        decided: decision.value,
      };
    }
    const compare = options.comparators?.[decision.key];
    const equal = compare
      ? compare(decision.value, seen.value)
      : canonicalJson(decision.value) === canonicalJson(seen.value);
    const verdict: DecisionVerdict = seen.stale ? 'stale' : equal ? 'match' : 'conflict';
    return {
      decision: decision.id,
      item: decision.item,
      key: decision.key,
      verdict,
      why: seen.stale
        ? 'observed value comes from a superseded source'
        : equal
          ? 'observed value equals the decision'
          : 'observed value differs from the decision',
      decided: decision.value,
      observed: seen.value,
      impl_ref: seen.ref,
    };
  });
  const tally: Partial<Record<DecisionVerdict, number>> = {};
  for (const check of checks) tally[check.verdict] = (tally[check.verdict] ?? 0) + 1;
  const red = checks.some((check) => check.verdict === 'conflict' || check.verdict === 'stale');
  const caseId = decisions[0]?.case_id ?? observed?.case_id ?? 'unknown';
  return {
    case_id: caseId,
    checked_at: options.now,
    ...(observed ? { impl: observed.impl } : {}),
    tally,
    status: red ? 'red' : 'green',
    checks,
  };
}

export function buildLock(
  decisions: readonly DecisionRecord[],
  report: DecisionConformanceReport
): DecisionLock {
  return {
    version: '1.0.0',
    case_id: report.case_id,
    generated_at: report.checked_at,
    ...(report.impl ? { impl: report.impl } : {}),
    status: report.status,
    decisions: activeDecided(decisions).map((decision) => ({
      id: decision.id,
      item: decision.item,
      key: decision.key,
      level: decision.level,
      value: decision.value,
      basis: decision.basis.map(({ ref, version }) => ({ ref, version })),
    })),
  };
}
