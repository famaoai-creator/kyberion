/**
 * Key result contract — shared by dot charters (`goal.key_results`) and
 * organization objectives. Pure types plus progress math; measuring a metric
 * lives in the engines (`dot-key-results`), never here.
 */

import type { StateProbeSpec } from './state-probe.js';

export const KEY_RESULT_ORG_METRICS = [
  'overdue_operations',
  'open_incidents',
  'pending_decisions',
  'unhealthy_services',
] as const;
export type KeyResultOrgMetric = (typeof KEY_RESULT_ORG_METRICS)[number];

export type KeyResultAggregate = 'value' | 'count';

export type KeyResultMetric =
  | { source: 'probe'; probe: StateProbeSpec; aggregate?: KeyResultAggregate }
  /** Repo-confined JSON file; `json_path` selects the value. */
  | { source: 'file'; path: string; json_path: string; aggregate?: KeyResultAggregate }
  /** Percent of recent dot-signal-ledger rows that were healthy. */
  | { source: 'signal_ratio'; signal: string; window_hours?: number }
  | { source: 'org_metric'; metric: KeyResultOrgMetric }
  /** Organization KRs only: a person records the value (`objective kr record`); sweeps skip it. */
  | { source: 'manual' };

export type KeyResultDirection = 'increase' | 'decrease' | 'maintain';

export interface KeyResultSpec {
  kr_id: string;
  title: string;
  metric: KeyResultMetric;
  target: number;
  direction: KeyResultDirection;
  baseline?: number;
  unit?: string;
  weight?: number;
  every_s?: number;
  settle_minutes?: number;
}

export interface ObjectiveRef {
  organization_id?: string;
  objective_id: string;
}

export const KEY_RESULT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
export const MAX_KEY_RESULTS = 10;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Progress toward the target, 0 (no progress) .. 1 (met). Non-finite values give 0. */
export function keyResultProgress(spec: KeyResultSpec, value: number): number {
  if (!Number.isFinite(value)) return 0;
  const { target, direction } = spec;
  if (direction === 'maintain') {
    return clamp01(1 - Math.abs(value - target) / Math.max(Math.abs(target), 1));
  }
  const increase = direction === 'increase';
  if (increase ? value >= target : value <= target) return 1;
  if (spec.baseline !== undefined && spec.baseline !== target) {
    const span = increase ? target - spec.baseline : spec.baseline - target;
    if (span > 0) {
      return clamp01(increase ? (value - spec.baseline) / span : (spec.baseline - value) / span);
    }
  }
  if (increase) {
    // No usable baseline: measure against zero.
    return target > 0 ? clamp01(value / target) : 0;
  }
  // decrease without baseline: ratio of target to current, so 0 -> any positive value decays.
  return clamp01(target >= 0 ? (target + 1) / (value + 1) : 0);
}
