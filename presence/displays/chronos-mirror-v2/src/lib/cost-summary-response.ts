import { isRecord } from '@agent/core/foundation/primitives';
import type { CostSummary } from './su-surface-data';

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function hasSafeKeys(value: Record<string, unknown>): boolean {
  return Object.keys(value).every((key) => !DANGEROUS_KEYS.has(key));
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return isFiniteNonNegative(value) && Number.isInteger(value);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function parseMissionBreakdown(value: unknown): CostSummary['missionBreakdown'] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = value.map((entry) => {
    if (
      !isRecord(entry) ||
      !hasSafeKeys(entry) ||
      typeof entry.missionId !== 'string' ||
      !entry.missionId.trim() ||
      !isFiniteNonNegative(entry.tokens) ||
      !isFiniteNonNegative(entry.usd) ||
      !isNonNegativeInteger(entry.entryCount) ||
      !isOptionalString(entry.lastSeen)
    ) {
      return undefined;
    }
    return entry as CostSummary['missionBreakdown'][number];
  });
  return entries.some((entry) => !entry) ? undefined : (entries as CostSummary['missionBreakdown']);
}

export function parseCostSummary(value: unknown): CostSummary | undefined {
  if (!isRecord(value) || !hasSafeKeys(value)) return undefined;
  if (
    !isFiniteNonNegative(value.totalTokens) ||
    !isFiniteNonNegative(value.totalUsd) ||
    !isNonNegativeInteger(value.entryCount) ||
    !isNonNegativeInteger(value.missionCount) ||
    !isOptionalString(value.since) ||
    (value.budgetUsd !== undefined && !isFiniteNonNegative(value.budgetUsd)) ||
    (value.remainingUsd !== undefined &&
      value.remainingUsd !== null &&
      !isFiniteNonNegative(value.remainingUsd)) ||
    typeof value.overBudget !== 'boolean'
  ) {
    return undefined;
  }

  const generation = value.generation;
  if (
    !isRecord(generation) ||
    !hasSafeKeys(generation) ||
    !isFiniteNonNegative(generation.actualUsd) ||
    !isNonNegativeInteger(generation.settledJobs) ||
    !isNonNegativeInteger(generation.awaitingActualCost)
  ) {
    return undefined;
  }

  const missionBreakdown = parseMissionBreakdown(value.missionBreakdown);
  if (!missionBreakdown) return undefined;
  return value as CostSummary;
}

export function parseCostSummaryResponse(value: unknown): { summary: CostSummary } | undefined {
  if (!isRecord(value) || !hasSafeKeys(value)) return undefined;
  const summary = parseCostSummary(value.summary);
  return summary ? { summary } : undefined;
}
