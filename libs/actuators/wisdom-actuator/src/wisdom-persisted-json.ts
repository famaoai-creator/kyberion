import { isRecord, readJson } from '@agent/core/foundation';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat } from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export type WisdomJsonObject = Record<string, unknown>;

export interface WisdomReconcilePipelineStep {
  type: 'capture' | 'transform' | 'apply' | 'control';
  op: string;
  params: WisdomJsonObject;
}

export interface WisdomReconcileStrategy {
  id?: string;
  for_each?: {
    op: string;
    params: WisdomJsonObject;
  };
  pipeline: WisdomReconcilePipelineStep[];
  params?: WisdomJsonObject;
}

function hasSafeKeys(value: WisdomJsonObject): boolean {
  return Object.keys(value).every((key) => !DANGEROUS_KEYS.has(key));
}

/**
 * Parse a persisted wisdom artifact without allowing an arbitrary JSON value
 * to cross into decision logic. Nested fields remain operation-specific; the
 * caller must validate those before consuming them.
 */
export function parseWisdomJsonObject(value: unknown): WisdomJsonObject | null {
  return isRecord(value) && hasSafeKeys(value) ? value : null;
}

export function readWisdomJsonAtPath(filePath: string, label = 'wisdom JSON'): unknown {
  const safePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
  if (!safeExistsSync(safePath) || !safeLstat(safePath).isFile()) {
    throw new Error(`${label} must be an existing regular file: ${safePath}`);
  }
  return readJson(safePath);
}

export function readWisdomJsonObjectAtPath(
  filePath: string,
  label = 'wisdom JSON'
): WisdomJsonObject {
  const parsed = parseWisdomJsonObject(readWisdomJsonAtPath(filePath, label));
  if (!parsed) {
    throw new Error(`[WISDOM_JSON_SHAPE_INVALID] expected an object: ${filePath}`);
  }
  return parsed;
}

export function readWisdomJsonObject(relativePath: string): WisdomJsonObject {
  const absolutePath = assertSafeRepositoryPath(pathResolver.rootResolve(relativePath));
  return readWisdomJsonObjectAtPath(absolutePath, `wisdom JSON ${relativePath}`);
}

export function readWisdomRecordArray(
  source: WisdomJsonObject,
  fieldNames: readonly string[],
  label: string
): WisdomJsonObject[] {
  const fieldName = fieldNames.find((candidate) => source[candidate] !== undefined);
  if (!fieldName) return [];
  const value = source[fieldName];
  if (!Array.isArray(value)) {
    throw new Error(`[WISDOM_JSON_SHAPE_INVALID] ${label}.${fieldName} must be an array`);
  }
  const records = value.map((candidate, index) => parseWisdomJsonObject(candidate));
  if (records.some((record) => record === null)) {
    throw new Error(
      `[WISDOM_JSON_SHAPE_INVALID] ${label}.${fieldName}[${records.findIndex((record) => record === null)}] must be an object`
    );
  }
  return records as WisdomJsonObject[];
}

export function readWisdomStringArray(
  source: WisdomJsonObject,
  fieldName: string,
  label: string
): string[] {
  const value = source[fieldName];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((candidate) => typeof candidate !== 'string')) {
    throw new Error(`[WISDOM_JSON_SHAPE_INVALID] ${label}.${fieldName} must be string[]`);
  }
  return value as string[];
}

export function readWisdomString(
  source: WisdomJsonObject,
  fieldName: string,
  fallback: string,
  label: string
): string {
  const value = source[fieldName];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') {
    throw new Error(`[WISDOM_JSON_SHAPE_INVALID] ${label}.${fieldName} must be a string`);
  }
  return value;
}

function parsePipelineStep(value: unknown): WisdomReconcilePipelineStep | null {
  if (!isRecord(value) || !hasSafeKeys(value)) return null;
  if (
    (value.type !== 'capture' &&
      value.type !== 'transform' &&
      value.type !== 'apply' &&
      value.type !== 'control') ||
    typeof value.op !== 'string' ||
    value.op.trim().length === 0 ||
    !isRecord(value.params) ||
    !hasSafeKeys(value.params)
  ) {
    return null;
  }
  const nestedKeys = value.type === 'control' ? ['then', 'else', 'pipeline'] : [];
  for (const key of nestedKeys) {
    if (value.params[key] === undefined) continue;
    if (!Array.isArray(value.params[key])) return null;
    if (value.params[key].some((step) => parsePipelineStep(step) === null)) return null;
  }
  return {
    type: value.type,
    op: value.op,
    params: value.params,
  };
}

/** Validate the persisted strategy before reconcile can execute any step. */
export function parseWisdomReconcileStrategy(
  value: unknown
): { strategies: WisdomReconcileStrategy[] } | null {
  if (!isRecord(value) || !hasSafeKeys(value) || !Array.isArray(value.strategies)) return null;
  const strategies: WisdomReconcileStrategy[] = [];
  for (const candidate of value.strategies) {
    if (!isRecord(candidate) || !hasSafeKeys(candidate) || !Array.isArray(candidate.pipeline)) {
      return null;
    }
    if (candidate.id !== undefined && typeof candidate.id !== 'string') return null;
    const strategyId = typeof candidate.id === 'string' ? candidate.id : undefined;
    if (
      candidate.params !== undefined &&
      (!isRecord(candidate.params) || !hasSafeKeys(candidate.params))
    ) {
      return null;
    }
    const strategyParams = isRecord(candidate.params) ? candidate.params : undefined;
    const pipeline = candidate.pipeline.map(parsePipelineStep);
    if (pipeline.some((step) => step === null)) return null;
    let forEach: WisdomReconcileStrategy['for_each'];
    if (candidate.for_each !== undefined) {
      if (!isRecord(candidate.for_each) || !hasSafeKeys(candidate.for_each)) return null;
      if (
        typeof candidate.for_each.op !== 'string' ||
        candidate.for_each.op.trim().length === 0 ||
        !isRecord(candidate.for_each.params) ||
        !hasSafeKeys(candidate.for_each.params)
      ) {
        return null;
      }
      forEach = {
        op: candidate.for_each.op,
        params: candidate.for_each.params,
      };
    }
    strategies.push({
      ...(strategyId !== undefined ? { id: strategyId } : {}),
      ...(forEach ? { for_each: forEach } : {}),
      pipeline: pipeline as WisdomReconcilePipelineStep[],
      ...(strategyParams ? { params: strategyParams } : {}),
    });
  }
  return { strategies };
}
