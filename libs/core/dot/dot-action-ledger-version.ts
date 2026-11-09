/**
 * Versioned read-mapping for the hash-bound dot action ledger (concept model v2, D7).
 *
 * The ledger stores each action row and, inside `admission.proposal`, the admitted
 * proposal that `admission.semantic_hash` pins as a whole. Records are verified in
 * the exact form they were written, so the execution-shape key rename cannot be
 * applied to old rows in place. Instead the ledger is versioned:
 *
 * - version 1 (legacy, no `schema_version` on the row): the shape is stored as
 *   `work_shape` on the row and on its admitted proposal.
 * - version 2 ({@link DOT_ACTION_SCHEMA_VERSION}): the row carries
 *   `schema_version: 2` and the shape is stored as `execution_shape` on the row and
 *   on its admitted proposal. A proposal carries no version of its own on disk; its
 *   version is the one of the row that admitted it.
 *
 * Code only ever sees the mapped view (`execution_shape`). The current version is
 * the in-memory default (a read-back version-2 row equals the record that was
 * appended). A view mapped from a version-1 record keeps the in-memory marker
 * `schema_version: 1` (on the row and on its admitted proposal), so it is written
 * back — and hashed, and compared — exactly as it was written. A row rewritten across a status change keeps the
 * version of its admitted proposal, so binding comparisons are always like-for-like.
 * The mapping is a bijection: `writtenDotActionRow(readDotActionRow(raw))` has the
 * same keys and values as `raw`.
 */
import { recoveryEvidenceHash } from '../surface/front-desk-recovery-receipt.js';
import type { DotProposal } from './dot-proposals.js';
import type { DotActionRecord } from './dot-action-ledger.js';

/** Version written by this release; rows without `schema_version` are version 1. */
export const DOT_ACTION_SCHEMA_VERSION = 2;
export type DotActionSchemaVersion = 1 | typeof DOT_ACTION_SCHEMA_VERSION;

/** Persisted name of the execution-shape key in a record of the given version. */
export function dotActionShapeKey(
  version: DotActionSchemaVersion
): 'work_shape' | 'execution_shape' {
  return version === 1 ? 'work_shape' : 'execution_shape';
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function invalid(what: string): Error {
  return new Error(`[DOT_ACTION_SCHEMA] ${what}`);
}

/** Version of an in-memory proposal view: only the legacy marker selects version 1. */
export function dotProposalSchemaVersion(proposal: DotProposal): DotActionSchemaVersion {
  return (proposal as { schema_version?: unknown }).schema_version === 1
    ? 1
    : DOT_ACTION_SCHEMA_VERSION;
}

/** Map a stored proposal of a known version to its view. */
export function readDotProposal(raw: unknown, version: DotActionSchemaVersion): DotProposal {
  if (!plainObject(raw)) return raw as DotProposal;
  if (Object.hasOwn(raw, 'schema_version'))
    throw invalid('a stored proposal never carries schema_version');
  const legacy = dotActionShapeKey(1);
  const current = dotActionShapeKey(DOT_ACTION_SCHEMA_VERSION);
  if (version === DOT_ACTION_SCHEMA_VERSION) {
    if (Object.hasOwn(raw, legacy)) throw invalid('a version 2 proposal cannot carry work_shape');
    return raw as unknown as DotProposal;
  }
  if (Object.hasOwn(raw, current))
    throw invalid('a version 1 proposal cannot carry execution_shape');
  const { [legacy]: shape, ...rest } = raw;
  return {
    ...rest,
    ...(shape !== undefined ? { [current]: shape } : {}),
    schema_version: 1,
  } as unknown as DotProposal;
}

/** The exact persisted form of a proposal view (what `semantic_hash` pins). */
export function writtenDotProposal(proposal: DotProposal): Record<string, unknown> {
  const { schema_version: marker, ...rest } = proposal as DotProposal & {
    schema_version?: unknown;
  };
  if (Object.hasOwn(rest, dotActionShapeKey(1)))
    throw invalid('in-memory proposals use execution_shape');
  if (marker === undefined) return rest as Record<string, unknown>;
  if (marker !== 1)
    throw invalid('only the legacy marker schema_version: 1 is valid on a proposal');
  const { execution_shape: shape, ...fields } = rest;
  return { ...fields, ...(shape !== undefined ? { [dotActionShapeKey(1)]: shape } : {}) };
}

/** Hash pinned by `admission.semantic_hash`, always over the written proposal. */
export function dotProposalEvidenceHash(proposal: DotProposal): string {
  return recoveryEvidenceHash(writtenDotProposal(proposal));
}

/** Version of a record view: its admitted proposal decides, then the row marker. */
export function dotActionRecordSchemaVersion(record: DotActionRecord): DotActionSchemaVersion {
  if (record.admission?.proposal) return dotProposalSchemaVersion(record.admission.proposal);
  return record.schema_version === 1 ? 1 : DOT_ACTION_SCHEMA_VERSION;
}

/** Map one stored ledger row (shared index or scoped evidence) to its view. */
export function readDotActionRow(raw: unknown): DotActionRecord {
  if (!plainObject(raw)) return raw as DotActionRecord;
  const stored = raw.schema_version;
  if (stored !== undefined && stored !== DOT_ACTION_SCHEMA_VERSION)
    throw invalid(`unknown action schema_version ${JSON.stringify(stored)}`);
  const version: DotActionSchemaVersion = stored === undefined ? 1 : DOT_ACTION_SCHEMA_VERSION;
  const legacy = dotActionShapeKey(1);
  const current = dotActionShapeKey(DOT_ACTION_SCHEMA_VERSION);
  let row: Record<string, unknown>;
  if (version === 1) {
    if (Object.hasOwn(raw, current))
      throw invalid('a version 1 action row cannot carry execution_shape');
    const { [legacy]: shape, ...rest } = raw;
    row = { ...rest, ...(shape !== undefined ? { [current]: shape } : {}), schema_version: 1 };
  } else {
    if (Object.hasOwn(raw, legacy)) throw invalid('a version 2 action row cannot carry work_shape');
    // The current version is the in-memory default: a read-back row equals a fresh one.
    const { schema_version: _current, ...rest } = raw;
    row = rest;
  }
  if (plainObject(row.admission) && Object.hasOwn(row.admission, 'proposal'))
    row.admission = {
      ...row.admission,
      proposal: readDotProposal(row.admission.proposal, version),
    };
  return row as unknown as DotActionRecord;
}

/**
 * The exact persisted form of a record view. Hashes (`private_content_hash`,
 * recovery `action_hash`, `semantic_hash`) and binding comparisons run over this.
 */
export function writtenDotActionRow(record: DotActionRecord): Record<string, unknown> {
  const version = dotActionRecordSchemaVersion(record);
  const {
    schema_version: _marker,
    execution_shape: shape,
    ...rest
  } = record as DotActionRecord & {
    execution_shape?: unknown;
  };
  if (Object.hasOwn(rest, dotActionShapeKey(1)))
    throw invalid('in-memory action rows use execution_shape');
  const written: Record<string, unknown> = {
    ...rest,
    ...(shape !== undefined ? { [dotActionShapeKey(version)]: shape } : {}),
    ...(version === DOT_ACTION_SCHEMA_VERSION ? { schema_version: DOT_ACTION_SCHEMA_VERSION } : {}),
  };
  if (record.admission?.proposal)
    written.admission = {
      ...record.admission,
      proposal: writtenDotProposal(record.admission.proposal),
    };
  return written;
}

/**
 * True when `current` re-proposes an operation admitted under version 1: written in
 * that version it hashes to the original `semantic_hash`, so it is the same operation
 * and keeps its original admission (and the approvals pinned to it).
 */
export function sameVersionOneAdmission(
  prior: DotActionRecord['admission'],
  current: DotActionRecord['admission']
): boolean {
  return Boolean(
    prior &&
    current &&
    dotProposalSchemaVersion(prior.proposal) === 1 &&
    dotProposalSchemaVersion(current.proposal) !== 1 &&
    dotProposalEvidenceHash({ ...current.proposal, schema_version: 1 }) === prior.semantic_hash
  );
}
