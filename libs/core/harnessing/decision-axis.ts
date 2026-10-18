/**
 * Evidence-strength decision axis (harness2 import, Kyberion-shaped).
 *
 * Given the base outcome plus per-candidate outcomes on the same scenario,
 * classify the result set:
 *   auto_advance — exactly one dominant candidate on declared metrics; the
 *                  improvement is self-evident, so it may proceed on the
 *                  strength of its evidence trail without a human call.
 *   human_gate   — several plausible winners, or a win on mixed metrics;
 *                  judgment is required and a human must decide.
 *   keep_base    — no candidate beat the base: a valid outcome, not a failure.
 *   decline      — no usable execution evidence at all.
 *
 * The axis answers "what reaches a human" — the complaint that rubber-stamping
 * many trivial calls defeats the gate's purpose.
 */

import type { RunOutcome } from './probe-runner.js';

export type ProbeDecision = 'auto_advance' | 'human_gate' | 'keep_base' | 'decline';

export interface MetricSpec {
  /** Metric key read from outcome metrics bag (e.g. 'wall_ms' or a custom field). */
  key: string;
  direction: 'lower' | 'higher';
}

export interface DecisionReport {
  decision: ProbeDecision;
  winner: string | null;
  rationale: string;
  decisive_evidence: Array<{ label: string; delivered: boolean; metrics: Record<string, number> }>;
  auto_advance_allowed: boolean;
}

function metricOf(outcome: RunOutcome, key: string): number | null {
  const bag = outcome as unknown as Record<string, unknown>;
  const v = bag[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Does `a` dominate `b` on the declared metrics? Tie on every metric is not dominance. */
function dominates(a: RunOutcome, b: RunOutcome, metrics: MetricSpec[]): boolean {
  let strictlyBetter = false;
  for (const m of metrics) {
    const av = metricOf(a, m.key);
    const bv = metricOf(b, m.key);
    if (av === null || bv === null) continue;
    if (m.direction === 'lower') {
      if (av > bv) return false;
      if (av < bv) strictlyBetter = true;
    } else {
      if (av < bv) return false;
      if (av > bv) strictlyBetter = true;
    }
  }
  return strictlyBetter;
}

export function classifyProbeSet(
  base: RunOutcome | null,
  candidates: RunOutcome[],
  metrics: MetricSpec[] = []
): DecisionReport {
  const evidenceRow = (o: RunOutcome) => ({
    label: o.label,
    delivered: o.delivered,
    metrics: {
      exit_code: o.exit_code ?? -1,
      wall_ms: o.wall_ms,
      produced_files: o.produced_files.length,
    },
  });
  const decisive = [...(base ? [evidenceRow(base)] : []), ...candidates.map(evidenceRow)];
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

  if (ranOk.length === 0) {
    return report(
      'decline',
      null,
      `no candidate probe completed (${candidates.length} attempted); no execution evidence to act on`
    );
  }
  if (delivered.length === 0) {
    return report(
      base?.delivered ? 'keep_base' : 'decline',
      null,
      base?.delivered
        ? 'no candidate delivered while the base did — KEEP_BASE is a valid outcome'
        : 'no rollout (base or candidates) delivered; nothing to compare'
    );
  }
  if (base && !base.delivered && delivered.length >= 1) {
    // Base failed where candidates delivered — strongest possible contrast.
    if (delivered.length === 1) {
      return report(
        'auto_advance',
        delivered[0].label,
        `base failed to deliver while ${delivered[0].label} did — a decisive contrast requiring no further judgment`
      );
    }
    return report(
      'human_gate',
      null,
      `base failed but ${delivered.length} candidates delivered (${delivered.map((c) => c.label).join(', ')}); pick among them by judgment`
    );
  }

  // Base delivered: candidates must dominate it on declared metrics to win.
  const winners = metrics.length
    ? delivered.filter((c) => base && dominates(c, base, metrics))
    : delivered;
  if (winners.length === 0) {
    return report(
      'keep_base',
      null,
      metrics.length
        ? 'no delivered candidate dominates the base on the declared metrics'
        : 'base and candidates both delivered; without declared metrics a delivered-tie defaults to keep_base'
    );
  }
  if (winners.length === 1) {
    const w = winners[0];
    // A lone winner only auto-advances when it also dominates every other
    // delivered candidate — otherwise there are two plausible winners.
    const rivals = delivered.filter((c) => c.label !== w.label);
    const clearWin = metrics.length === 0 || rivals.every((r) => dominates(w, r, metrics));
    if (clearWin) {
      return report(
        'auto_advance',
        w.label,
        `${w.label} is the single candidate dominating the base${metrics.length ? ' on declared metrics' : ''}; the improvement is self-evident`
      );
    }
    return report(
      'human_gate',
      null,
      `${w.label} beats the base but not every delivered rival (${rivals.map((r) => r.label).join(', ')}); judgment required`
    );
  }
  return report(
    'human_gate',
    null,
    `${winners.length} candidates dominate the base (${winners.map((c) => c.label).join(', ')}); a human must pick`
  );
}
