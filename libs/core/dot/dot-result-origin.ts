/** Trusted-module origin boundary, not cryptographic authentication of hostile host JavaScript. */
import * as path from 'node:path';
import {
  dotResultCanonicalJson,
  dotResultHash,
  dotResultDigest,
  parseDotReportMarker,
  dotResultScopeSchema,
  type DotResultScope,
  type DotReportMarker,
} from './dot-result-records.js';
import type { DotWorkResultRow } from './dot-state-paths.js';
import type { DotCharter } from './dot-charter.js';

export interface DotResultOutcomeOrigin {
  rootDir: string;
  charter: DotCharter;
  scope: DotResultScope;
  row: DotWorkResultRow;
  phase: 'active_execution' | 'pipeline_continuation' | 'negative_recovery';
  leaseId?: string;
}
export interface DotReportMarkerOrigin {
  rootDir: string;
  charter: DotCharter;
  scope: DotResultScope;
  marker: DotReportMarker;
}
const outcomeBrand = Symbol('dot-result-outcome');
const reportBrand = Symbol('dot-result-report');
export type DotResultOutcomePermit = Readonly<{ [outcomeBrand]: true }>;
export type DotReportMarkerPermit = Readonly<{ [reportBrand]: true }>;
const outcomes = new WeakMap<object, string>();
const reports = new WeakMap<object, string>();
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
function base(input: { rootDir: string; charter: DotCharter; scope: DotResultScope }) {
  if (!path.isAbsolute(input.rootDir) || path.resolve(input.rootDir) !== input.rootDir)
    throw new Error('Origin root differs');
  const scope = dotResultScopeSchema.parse(input.scope);
  if (
    dotResultHash(scope) !== dotResultHash(input.scope) ||
    dotResultHash(scope) !== dotResultHash(input.charter.scope) ||
    !ID.test(input.charter.dot_id) ||
    input.charter.authority.authority_role === 'dot_result_writer'
  )
    throw new Error('Origin charter scope differs');
  return { rootDir: input.rootDir, charter_hash: dotResultHash(input.charter), scope };
}
function outcomeIdentity(input: DotResultOutcomeOrigin): string {
  dotResultCanonicalJson(input);
  const { row, phase } = input;
  if (
    !['active_execution', 'pipeline_continuation', 'negative_recovery'].includes(phase) ||
    row.dot_id !== input.charter.dot_id ||
    row.status === 'skipped' ||
    !['done', 'blocked', 'failed'].includes(row.status) ||
    !['goal_turn', 'delegated', 'pipeline', 'escalated'].includes(row.mode) ||
    ![row.work_item_id, row.action_ref, row.attempt_id].every(
      (value) => typeof value === 'string' && ID.test(value)
    ) ||
    !Number.isFinite(Date.parse(row.started_at)) ||
    !Number.isFinite(Date.parse(row.completed_at)) ||
    Date.parse(row.completed_at) < Date.parse(row.started_at) ||
    (phase === 'active_execution' && (!input.leaseId || !ID.test(input.leaseId))) ||
    (phase === 'negative_recovery' && (row.status === 'done' || row.mode !== 'escalated')) ||
    (phase === 'pipeline_continuation' && row.mode !== 'pipeline')
  )
    throw new Error('Outcome origin shape differs');
  return dotResultHash({
    ...base(input),
    phase,
    row_digest: dotResultDigest(row),
    full_row_hash: dotResultHash(row),
    ...(input.leaseId ? { lease_id: input.leaseId } : {}),
  });
}
function reportIdentity(input: DotReportMarkerOrigin): string {
  dotResultCanonicalJson(input);
  const marker = parseDotReportMarker(input.marker);
  if (
    marker.dot_id !== input.charter.dot_id ||
    dotResultHash(marker.scope) !== dotResultHash(input.scope)
  )
    throw new Error('Report origin differs');
  return dotResultHash({ ...base(input), marker });
}
/** Import gate restricts minting to dot-executor.ts after its actual port outcome exists. */
export function mintDotResultOutcomePermit(input: DotResultOutcomeOrigin): DotResultOutcomePermit {
  const identity = outcomeIdentity(input);
  const token = Object.freeze({ [outcomeBrand]: true as const });
  outcomes.set(token, identity);
  return token;
}
/** Consumed even on mismatch or downstream failure; minting another outcome is a separate trusted flow. */
export function consumeDotResultOutcomePermit(
  token: unknown,
  expected: DotResultOutcomeOrigin
): void {
  if (!token || typeof token !== 'object') throw new Error('Missing result origin permit');
  const identity = outcomes.get(token);
  outcomes.delete(token);
  if (!identity || identity !== outcomeIdentity(expected))
    throw new Error('Result origin permit differs or was consumed');
}
/** Import gate restricts this mint to dot-executor-reports.ts after its inbox port acknowledges. */
export function mintDotReportMarkerPermit(input: DotReportMarkerOrigin): DotReportMarkerPermit {
  const identity = reportIdentity(input);
  const token = Object.freeze({ [reportBrand]: true as const });
  reports.set(token, identity);
  return token;
}
export function consumeDotReportMarkerPermit(
  token: unknown,
  expected: DotReportMarkerOrigin
): void {
  if (!token || typeof token !== 'object') throw new Error('Missing report origin permit');
  const identity = reports.get(token);
  reports.delete(token);
  if (!identity || identity !== reportIdentity(expected))
    throw new Error('Report origin permit differs or was consumed');
}
