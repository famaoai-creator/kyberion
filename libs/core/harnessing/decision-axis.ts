/**
 * Evidence-strength decision axis (harness2 import, Kyberion-shaped).
 * auto_advance = decisive single-winner contrast; human_gate = judgment needed;
 * keep_base = no candidate beat base; decline = no usable evidence.
 */

import type { RunOutcome } from './probe-runner.js';

export type ProbeDecision = 'auto_advance' | 'human_gate' | 'keep_base' | 'decline';

export interface MetricSpec {
  key: string;
  direction: 'lower' | 'higher';
}

export interface DecisionReport {
  decision: ProbeDecision;
  winner: string | null;
  rationale: string;
  decisive_evidence: Array<{ label: string; delivered: boolean; metrics: Record<string, number> }>;
  auto_advance_allowed: boolean;
  /** Declared metrics that resolved to null on every outcome — the axis
   *  judged nothing with them, so the report must not imply it did. */
  unresolved_metrics: string[];
}

function metricOf(outcome: RunOutcome, key: string): number | null {
  const v = (outcome as unknown as Record<string, unknown>)[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  // Array-typed fields (produced_files) resolve to their element count.
  if (Array.isArray(v)) return v.length;
  return null;
}

/** a dominates b: no-worse on every resolvable metric AND strictly-better on >=1. Empty metrics => false. */
function dominates(a: RunOutcome, b: RunOutcome, metrics: MetricSpec[]): boolean {
  let strictlyBetter = false;
  for (const m of metrics) {
    const av = metricOf(a, m.key);
    const bv = metricOf(b, m.key);
    if (av === null || bv === null) continue;
    if (m.direction === 'lower' ? av > bv : av < bv) return false;
    if (av !== bv) strictlyBetter = true;
  }
  return strictlyBetter;
}

export function classifyProbeSet(
  base: RunOutcome | null,
  candidates: RunOutcome[],
  metrics: MetricSpec[] = []
): DecisionReport {
  const row = (o: RunOutcome) => ({
    label: o.label,
    delivered: o.delivered,
    metrics: {
      exit_code: o.exit_code ?? -1,
      wall_ms: o.wall_ms,
      produced_files: o.produced_files.length,
    },
  });
  const decisive = [...(base ? [row(base)] : []), ...candidates.map(row)];
  const report = (
    decision: ProbeDecision,
    winner: string | null,
    rationale: string
  ): DecisionReport => ({
    decision,
    winner,
    rationale,
    decisive_evidence: decisive,
    auto_advance_allowed: decision === 'auto_advance',
  });

  const delivered = candidates.filter((c) => c.ok && c.delivered);
  const ranOk = candidates.filter((c) => c.ok);

  // A baseline that never executed is missing evidence, not a losing baseline.
  if (!base || !base.ok) {
    if (delivered.length > 0) {
      return report(
        'human_gate',
        null,
        'no baseline outcome to contrast against — candidates delivered but the contrast is unverifiable'
      );
    }
    return report(
      'decline',
      null,
      'no usable execution evidence (baseline unusable, no candidate delivered)'
    );
  }
  if (ranOk.length === 0) {
    return report('decline', null, `no candidate probe completed (${candidates.length} attempted)`);
  }
  if (delivered.length === 0) {
    return report(
      base.delivered ? 'keep_base' : 'decline',
      null,
      base.delivered
        ? 'no candidate delivered while the base did — KEEP_BASE is a valid outcome'
        : 'no rollout delivered; nothing to compare'
    );
  }
  if (!base.delivered) {
    // Base ran and failed where candidates delivered — decisive contrast.
    return delivered.length === 1
      ? report(
          'auto_advance',
          delivered[0].label,
          `base ran and failed to deliver while ${delivered[0].label} did — decisive contrast`
        )
      : report(
          'human_gate',
          null,
          `base failed but ${delivered.length} candidates delivered; pick by judgment`
        );
  }
  // Base delivered: without declared metrics dominance cannot be established.
  if (metrics.length === 0) {
    return report(
      'human_gate',
      null,
      'no declared metrics — dominance over the delivering base cannot be established; a human must judge'
    );
  }
  const winners = delivered.filter((c) => dominates(c, base, metrics));
  if (winners.length === 0) {
    return report(
      'keep_base',
      null,
      'no delivered candidate dominates the base on the declared metrics'
    );
  }
  if (winners.length === 1) {
    const w = winners[0];
    const rivals = delivered.filter((c) => c.label !== w.label);
    if (rivals.every((r) => dominates(w, r, metrics))) {
      return report(
        'auto_advance',
        w.label,
        `${w.label} is the single candidate dominating the base and every rival on declared metrics — self-evident improvement`
      );
    }
    return report(
      'human_gate',
      null,
      `${w.label} beats the base but not every delivered rival (${rivals.map((r) => r.label).join(', ')})`
    );
  }
  return report(
    'human_gate',
    null,
    `${winners.length} candidates dominate the base (${winners.map((c) => c.label).join(', ')})`
  );
}
