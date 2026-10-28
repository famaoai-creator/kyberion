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

export function hasValidCostCoverage(value: Record<string, unknown>): boolean {
  return (
    (value.referenceUsd === undefined || isFiniteNonNegative(value.referenceUsd)) &&
    [
      'includedCalls',
      'unknownCostCalls',
      'actualCostCalls',
      'estimatedCostCalls',
      'referenceCostCalls',
    ].every((key) => value[key] === undefined || isNonNegativeInteger(value[key])) &&
    (value.costComplete === undefined || typeof value.costComplete === 'boolean') &&
    !(value.costComplete === true && Number(value.unknownCostCalls ?? 0) > 0)
  );
}

function parseMissionBreakdown(value: unknown): CostSummary['missionBreakdown'] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = value.map((entry) => {
    if (
      !isRecord(entry) ||
      !hasSafeKeys(entry) ||
      !hasValidCostCoverage(entry) ||
      typeof entry.missionId !== 'string' ||
      !entry.missionId.trim() ||
      !isFiniteNonNegative(entry.tokens) ||
      !isFiniteNonNegative(entry.usd) ||
      !isNonNegativeInteger(entry.entryCount) ||
      !isOptionalString(entry.lastSeen)
    ) {
      return undefined;
    }
    return {
      ...entry,
      missionId: entry.missionId,
      tokens: entry.tokens,
      usd: entry.usd,
      entryCount: entry.entryCount,
      ...(entry.lastSeen !== undefined ? { lastSeen: entry.lastSeen } : {}),
    };
  });
  return entries.some((entry) => !entry) ? undefined : (entries as CostSummary['missionBreakdown']);
}

export function parseCostSummary(value: unknown): CostSummary | undefined {
  if (!isRecord(value) || !hasSafeKeys(value) || !hasValidCostCoverage(value)) return undefined;
  if (
    !isFiniteNonNegative(value.totalTokens) ||
    !isFiniteNonNegative(value.totalUsd) ||
    !isNonNegativeInteger(value.entryCount) ||
    !isNonNegativeInteger(value.missionCount) ||
    !isOptionalString(value.since) ||
    !isOptionalString(value.partialNotice) ||
    (value.withheldPartitions !== undefined && !isNonNegativeInteger(value.withheldPartitions)) ||
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
  return value as unknown as CostSummary;
}

export function parseCostSummaryResponse(value: unknown): { summary: CostSummary } | undefined {
  if (!isRecord(value) || !hasSafeKeys(value)) return undefined;
  const summary = parseCostSummary(value.summary);
  return summary ? { summary } : undefined;
}
