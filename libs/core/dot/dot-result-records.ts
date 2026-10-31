/** Pure result-journal projection. Report markers never become execution or usage rows. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { isValidTenantSlug } from '../foundation/scope.js';
import type { DotWorkResultRow } from './dot-state-paths.js';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u);
const timestamp = z
  .string()
  .datetime()
  .refine((value) => new Date(value).toISOString() === value);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const dotResultScopeSchema = z
  .object({
    tier: z.literal('confidential'),
    tenant_slug: z.string().refine(isValidTenantSlug),
    organization_id: id.optional(),
    project_id: id.optional(),
  })
  .strict()
  .refine((value) => !value.project_id || Boolean(value.organization_id));
export type DotResultScope = z.infer<typeof dotResultScopeSchema>;

/** Lossless bounded finite JSON; no custom prototypes, hidden keys, accessors or sparse arrays. */
export function dotResultCanonicalJson(value: unknown): string {
  const ancestors = new Set<object>();
  const visit = (item: unknown, depth: number): string => {
    if (depth > 32) throw new Error('Result JSON nesting exceeds bound');
    if (item === null || typeof item === 'string' || typeof item === 'boolean')
      return JSON.stringify(item);
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
    if (typeof item !== 'object' || !item || ancestors.has(item))
      throw new Error('Result requires finite acyclic JSON');
    const array = Array.isArray(item);
    if (Object.getPrototypeOf(item) !== (array ? Array.prototype : Object.prototype))
      throw new Error('Result JSON prototype differs');
    const keys = Reflect.ownKeys(item);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      if (array && key === 'length') continue;
      if (
        typeof key !== 'string' ||
        key === '__proto__' ||
        !descriptor.enumerable ||
        !('value' in descriptor)
      )
        throw new Error('Lossy result JSON properties');
      if (array) {
        const index = Number(key);
        if (!Number.isInteger(index) || index < 0 || index >= item.length || String(index) !== key)
          throw new Error('Lossy result array');
      }
    }
    ancestors.add(item);
    try {
      if (array) {
        const encoded: string[] = [];
        for (let index = 0; index < item.length; index++) {
          if (!Object.hasOwn(item, index)) throw new Error('Sparse result array');
          encoded.push(visit(item[index], depth + 1));
        }
        return '[' + encoded.join(',') + ']';
      }
      return (
        '{' +
        (keys as string[])
          .sort()
          .map(
            (key) =>
              JSON.stringify(key) + ':' + visit((item as Record<string, unknown>)[key], depth + 1)
          )
          .join(',') +
        '}'
      );
    } finally {
      ancestors.delete(item);
    }
  };
  const encoded = visit(value, 0);
  if (Buffer.byteLength(encoded, 'utf8') > 1024 * 1024)
    throw new Error('Result JSON exceeds 1 MiB');
  return encoded;
}
export function dotResultHash(value: unknown): string {
  return createHash('sha256').update(dotResultCanonicalJson(value)).digest('hex');
}
function detached<T>(value: T): T {
  return JSON.parse(dotResultCanonicalJson(value));
}

/** Keep exactly the existing eight-input report identity, including omitted attempt -> null. */
export function executorReportKey(row: DotWorkResultRow, reportTo: string): string {
  return `dot-executor:${createHash('sha256')
    .update(
      JSON.stringify([
        row.dot_id,
        reportTo,
        row.work_item_id,
        row.action_ref,
        row.attempt_id,
        row.started_at,
        row.completed_at,
        row.status,
      ])
    )
    .digest('hex')}`;
}
export function dotResultDigest(value: unknown): string {
  dotResultCanonicalJson(value);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.hasOwn(value, 'kind'))
    throw new Error('Expected original result row');
  const original = { ...value } as Record<string, unknown>;
  delete original.report_enqueued_at;
  delete original.report_suppressed;
  return dotResultHash(original);
}
export const dotReportMarkerSchema = z
  .object({
    kind: z.literal('dot-result-report-marker'),
    schema_version: z.literal('1'),
    dot_id: id,
    work_item_id: id,
    action_ref: id,
    attempt_id: id,
    scope: dotResultScopeSchema,
    result_digest: digest,
    report_key: z.string().regex(/^dot-executor:[a-f0-9]{64}$/u),
    report_to_dot_id: id,
    report_enqueued_at: timestamp,
    report_suppressed: z.literal('capability_unavailable').optional(),
  })
  .strict();
export type DotReportMarker = z.infer<typeof dotReportMarkerSchema>;
export function parseDotReportMarker(value: unknown): DotReportMarker {
  const before = dotResultCanonicalJson(value);
  const parsed = dotReportMarkerSchema.parse(value);
  if (before !== dotResultCanonicalJson(parsed)) throw new Error('Lossy result marker');
  return detached(parsed);
}
function validateMarkedOriginal(row: DotWorkResultRow, receiptTime: string): void {
  for (const value of [
    row.dot_id,
    row.work_item_id,
    row.action_ref,
    row.attempt_id,
    row.report_to_dot_id,
  ])
    id.parse(value);
  if (
    !['done', 'blocked', 'failed'].includes(row.status) ||
    !['goal_turn', 'delegated', 'pipeline', 'escalated'].includes(row.mode)
  )
    throw new Error('Marked original is not terminal');
  const started = Date.parse(timestamp.parse(row.started_at));
  const completed = Date.parse(timestamp.parse(row.completed_at));
  const receipt = Date.parse(timestamp.parse(receiptTime));
  if (started > completed || completed > receipt)
    throw new Error('Marked result time order differs');
  if (Object.hasOwn(row, 'report_enqueued_at')) timestamp.parse(row.report_enqueued_at);
  if (Object.hasOwn(row, 'report_suppressed'))
    z.literal('capability_unavailable').parse(row.report_suppressed);
}
function validateSuppression(
  row: DotWorkResultRow,
  suppressed: DotWorkResultRow['report_suppressed']
): void {
  if ((row.reason_code === 'capability_unavailable') !== (suppressed === 'capability_unavailable'))
    throw new Error('Report suppression differs from original capability result');
}
export function createDotReportMarker(input: {
  row: DotWorkResultRow;
  scope: DotResultScope;
  reportTo: string;
  enqueuedAt: string;
  suppressed?: DotWorkResultRow['report_suppressed'];
}): DotReportMarker {
  dotResultCanonicalJson(input);
  const row = input.row;
  validateMarkedOriginal(row, input.enqueuedAt);
  validateSuppression(row, input.suppressed);
  if (
    !row.attempt_id ||
    !row.report_to_dot_id ||
    row.report_to_dot_id !== input.reportTo ||
    !['done', 'blocked', 'failed'].includes(row.status) ||
    Date.parse(input.enqueuedAt) < Date.parse(row.completed_at)
  )
    throw new Error('Result report identity differs');
  return parseDotReportMarker({
    kind: 'dot-result-report-marker',
    schema_version: '1',
    dot_id: row.dot_id,
    work_item_id: row.work_item_id,
    action_ref: row.action_ref,
    attempt_id: row.attempt_id,
    scope: input.scope,
    result_digest: dotResultDigest(row),
    report_key: executorReportKey(row, input.reportTo),
    report_to_dot_id: input.reportTo,
    report_enqueued_at: input.enqueuedAt,
    ...(input.suppressed ? { report_suppressed: input.suppressed } : {}),
  });
}

/** Unmarked legacy JSON rows retain their original shape; privileged readers validate them separately. */
export function projectDotResultRecords(
  records: readonly unknown[],
  scope?: DotResultScope
): unknown[] {
  // Bound individual journal records, not the cumulative journal. Legacy ledgers can exceed 1 MiB.
  if (!Array.isArray(records) || Object.getPrototypeOf(records) !== Array.prototype)
    throw new Error('Expected plain result record array');
  const keys = Reflect.ownKeys(records);
  if (keys.length !== records.length + 1) throw new Error('Lossy result record array');
  for (const key of keys) {
    if (key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(records, key)!;
    const index = typeof key === 'string' ? Number(key) : NaN;
    if (
      typeof key !== 'string' ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= records.length ||
      String(index) !== key ||
      !descriptor.enumerable ||
      !('value' in descriptor)
    )
      throw new Error('Lossy result record array');
  }
  if (scope !== undefined) dotResultCanonicalJson(scope);
  const expectedScope = scope === undefined ? undefined : dotResultScopeSchema.parse(scope);
  const output: unknown[] = [];
  const originals = new Map<string, { row: DotWorkResultRow; index: number }[]>();
  const markers = new Map<string, DotReportMarker>();
  for (const value of records) {
    dotResultCanonicalJson(value);
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.hasOwn(value, 'kind')
    ) {
      const marker = parseDotReportMarker(value);
      if (!expectedScope || dotResultHash(marker.scope) !== dotResultHash(expectedScope))
        throw new Error('Marker scope differs');
      const candidates = originals.get(marker.result_digest) ?? [];
      // A duplicate original row would otherwise count the same outcome twice after marking.
      if (candidates.length !== 1) throw new Error('Marker original missing or ambiguous');
      const { row, index } = candidates[0];
      validateMarkedOriginal(row, marker.report_enqueued_at);
      validateSuppression(row, marker.report_suppressed);
      if (
        row.dot_id !== marker.dot_id ||
        row.work_item_id !== marker.work_item_id ||
        row.action_ref !== marker.action_ref ||
        row.attempt_id !== marker.attempt_id ||
        row.report_to_dot_id !== marker.report_to_dot_id ||
        executorReportKey(row, marker.report_to_dot_id) !== marker.report_key ||
        Date.parse(marker.report_enqueued_at) < Date.parse(row.completed_at)
      )
        throw new Error('Marker result identity differs');
      const prior = markers.get(marker.result_digest);
      if (prior && dotResultHash(prior) !== dotResultHash(marker))
        throw new Error('Conflicting result marker');
      if (
        (row.report_enqueued_at && row.report_enqueued_at !== marker.report_enqueued_at) ||
        (row.report_suppressed && row.report_suppressed !== marker.report_suppressed)
      )
        throw new Error('Marker conflicts with original receipt');
      markers.set(marker.result_digest, marker);
      output[index] = {
        ...row,
        report_enqueued_at: marker.report_enqueued_at,
        ...(marker.report_suppressed ? { report_suppressed: marker.report_suppressed } : {}),
      };
      continue;
    }
    const row = detached(value);
    output.push(row);
    if (row && typeof row === 'object' && !Array.isArray(row)) {
      const hash = dotResultDigest(row);
      const entries = originals.get(hash) ?? [];
      if (markers.has(hash)) throw new Error('Original repeated after its marker');
      entries.push({ row: row as DotWorkResultRow, index: output.length - 1 });
      originals.set(hash, entries);
    }
  }
  return output;
}
