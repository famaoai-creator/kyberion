/** Durable action snapshots and bounded terminal append, independent of dot orchestration. */
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { pathResolver } from '../path-resolver.js';
import { getRegisteredEnvText } from '../foundation/env.js';
import { safeMkdir, safeLstat, assertSafeRepositoryPath } from '../secure-io.js';
import { appendJsonLine, writeJsonLines } from '../foundation/json.js';
import { jsonlFileSize, streamJsonLines } from '../jsonl-read.js';
import { createLogger } from '../logger.js';
import { withLockSync } from '../foundation/lock-utils.js';
import { resolvePolicyIdentityContext } from '../identity-context-bridge.js';
import { withFrontDeskDispatchLock } from '../surface/front-desk-dispatch-lock.js';
import { readFrontDeskExecutionRecovery } from '../surface/front-desk-conversation-persistence.js';
import { assertUndispatchedWorkItemEvidenceHeld } from '../workforce/work-coordination.js';
import {
  parseFrontDeskExecutionBinding,
  type FrontDeskExecutionBinding,
} from '../surface/front-desk-execution-contract.js';
import {
  recoveryEvidenceHash,
  parseFrontDeskExecutionRecoveryReceipt,
  sameRecoveryReceipt,
  type FrontDeskExecutionRecoveryReceipt,
} from '../surface/front-desk-recovery-receipt.js';
import type { DotWorkShape, DotDecisionLevel, DotProposal } from './dot-proposals.js';
import { parseMissionAdmissionRequest } from '../governance/mandate-shadow.js';
import type { DotCharter } from './dot-charter.js';
import { dotStatePath } from './dot-state-paths.js';
import { judgmentCanonicalHash } from '../organization/judgment-precedents.js';
import {
  parseDotJudgmentBinding,
  validateServerDotJudgmentProposal,
  type DotJudgmentBinding,
} from './dot-judgment-binding.js';
export const DOT_ACTION_LEDGER_PATH = 'active/shared/runtime/dot-action-ledger.jsonl';

const logger = createLogger('dot-action-ledger');

/**
 * Retention: none — the ledger stays `review_required`. Dispatch and recovery
 * replay full history (`readDotActionLedgerStrict` negative proofs such as
 * "no row of this action_ref was ever dispatched", and the original `parked`
 * row a recovery receipt hashes), so folding to latest-per-action_ref or
 * truncating could re-fire consumed actions. Readers stream (no size cap);
 * growth past this size only warns, once per doubling.
 */
export const DOT_ACTION_LEDGER_GROWTH_WARN_BYTES = 64 * 1024 * 1024;
let lastGrowthWarnBytes = 0;

export interface DotActionLedgerDeps {
  rootDir?: string;
  now?: () => Date;
  /** Trusted owner query; unrelated private content is never hydrated. */
  dotId?: string;
  /** Complete control-index proof without reading private proposal content. */
  indexOnly?: boolean;
  /** Range-read chunk size for the streaming readers (tests inject small values). */
  readChunkBytes?: number;
  /** Growth-warn threshold override (tests inject small values). */
  growthWarnBytes?: number;
}

export type DotActionStatus =
  'admitted' | 'dispatched' | 'parked' | 'waiting_capacity' | 'refused' | 'shadow' | 'declined';

export interface DotActionRecord {
  /** Server-authored immutable origin metadata; never exposed by the shared private index. */
  semantic_judgment?: DotJudgmentBinding;
  scope?: DotCharter['scope'];
  /** Present only on a metadata-only shared index; never executable by itself. */
  private_content_hash?: string;
  /** Trusted admission class; external effect authority is never inherited. */
  admission_only?: boolean;
  gate_action_id?: string;
  /** Immutable generic operation identity, persisted before an executable item exists. */
  admission?: {
    scope_hash: string;
    semantic_hash: string;
    operation_key?: string;
    ordinal: number;
    authority_role: string;
    proposal: DotProposal;
  };
  recovery_receipt?: FrontDeskExecutionRecoveryReceipt;
  front_desk_execution?: FrontDeskExecutionBinding;
  continuous_work?: DotProposal['continuous_work'];
  action_ref: string;
  dot_id: string;
  actor_id: string;
  action_id: string;
  title: string;
  objective: string;
  work_shape: DotWorkShape;
  mission_admission?: DotProposal['mission_admission'];
  status: DotActionStatus;
  proposal_hash: string;
  decision?: DotDecisionLevel;
  gate_decision?: DotDecisionLevel;
  floor?: DotDecisionLevel;
  handoff_to?: string;
  priority?: DotProposal['priority'];
  rationale?: string;
  /** Carried from the proposal into the WorkItem metadata for the executor (DL-01). */
  pipeline_ref?: DotProposal['pipeline_ref'];
  expected_effect?: DotProposal['expected_effect'];
  target?: DotProposal['target'];
  intent?: DotProposal['intent'];
  request_id?: string;
  work_item_id?: string;
  reason?: string;
  /** Set when the action was declined as `superseded` by another dot's approved action (DL-11). */
  superseded_by?: { dot_id: string; action_ref: string };
  /** Disposition override that recorded this action as `shadow` only (L0). */
  disposition_by?: string;
  /** Set when a pre-gate check forced an operator decision. */
  escalation?: {
    check_id: string;
    reason: string;
    link?: { action_ref: string; dot_id: string };
    /** All linked conflicts when several escalations merged; only `link` is superseded on approve. */
    links?: Array<{ action_ref: string; dot_id: string }>;
  };
  at: string;
}

/** Executable evidence must be complete; absence on an inventory index is never legacy off. */
export function assertDotActionJudgmentBinding(record: DotActionRecord): void {
  if (record.private_content_hash !== undefined)
    throw new Error(
      '[DOT_ACTION_CONTENT_UNAVAILABLE] shared index cannot be used as executable evidence'
    );
  const descriptor = Object.getOwnPropertyDescriptor(record, 'semantic_judgment');
  if ((descriptor && !('value' in descriptor)) || (!descriptor && 'semantic_judgment' in record))
    throw new Error('Judgment action binding must be an own data value');
  const binding = parseDotJudgmentBinding(descriptor?.value);
  const admitted = record.admission?.proposal;
  const admittedBinding = admitted ? validateServerDotJudgmentProposal(admitted) : undefined;
  if (!binding && !admittedBinding) return;
  judgmentCanonicalHash(record);
  if (
    !binding ||
    !admitted ||
    !admittedBinding ||
    !record.admission ||
    !isDotAdmissionIdentity(record.admission) ||
    judgmentCanonicalHash(binding) !== judgmentCanonicalHash(admittedBinding) ||
    judgmentCanonicalHash(record.scope) !== judgmentCanonicalHash(binding.scope) ||
    recoveryEvidenceHash(admitted) !== record.admission.semantic_hash
  )
    throw new Error('Judgment action scope, admission or immutable binding differs');
  for (const field of [
    'action_id',
    'title',
    'objective',
    'work_shape',
    'rationale',
    'priority',
    'pipeline_ref',
    'expected_effect',
    'target',
    'intent',
    'mission_admission',
    'handoff_to',
    'continuous_work',
    'front_desk_execution',
  ] as const) {
    const actual = record[field],
      original = admitted[field];
    if (actual === undefined && original === undefined) continue;
    if (
      actual === undefined ||
      original === undefined ||
      judgmentCanonicalHash(actual) !== judgmentCanonicalHash(original)
    )
      throw new Error(`Judgment action executable field differs: ${field}`);
  }
}

export function isDotAdmissionIdentity(
  value: unknown
): value is NonNullable<DotActionRecord['admission']> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    ['scope_hash', 'semantic_hash', 'authority_role'].every(
      (key) => typeof row[key] === 'string' && Boolean(row[key])
    ) &&
    Boolean(row.proposal && typeof row.proposal === 'object' && !Array.isArray(row.proposal)) &&
    Number.isInteger(row.ordinal) &&
    Number(row.ordinal) >= 0 &&
    (row.operation_key === undefined ||
      (typeof row.operation_key === 'string' && Boolean(row.operation_key)))
  );
}

function ledgerFile(deps: DotActionLedgerDeps): string {
  return path.join(deps.rootDir ?? pathResolver.rootDir(), DOT_ACTION_LEDGER_PATH);
}
function assertPrivateIndexHasNoJudgmentBody(record: DotActionRecord): void {
  if (
    record.private_content_hash !== undefined &&
    ['semantic_judgment', 'admission'].some((field) => Object.hasOwn(record, field))
  )
    throw new Error('[DOT_ACTION_CONTENT_UNAVAILABLE] shared index contains private judgment body');
}

function hydratePrivateAction(record: DotActionRecord, deps: DotActionLedgerDeps): DotActionRecord {
  assertPrivateIndexHasNoJudgmentBody(record);
  if (record.private_content_hash === undefined) {
    assertDotActionJudgmentBinding(record);
    return record;
  }
  if (
    typeof record.private_content_hash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(record.private_content_hash)
  )
    throw new Error('[DOT_ACTION_CONTENT_UNAVAILABLE] invalid private content identity');
  if (!record.scope || record.scope.tier === 'public')
    throw new Error('[DOT_ACTION_CONTENT_UNAVAILABLE] invalid private index scope');
  if (
    record.scope.tier === 'personal' &&
    record.scope.owner_nhi !== getRegisteredEnvText('KYBERION_NHI_ID')?.trim()
  )
    throw new Error('[DOT_PERSONAL_OWNER] personal action belongs to another process owner');
  const file = path.join(
    deps.rootDir ?? pathResolver.rootDir(),
    dotStatePath({ scope: record.scope }, 'action-ledger.jsonl')
  );
  let full: DotActionRecord | undefined;
  for (const row of streamJsonLines<DotActionRecord>(file, {
    onMalformed: 'skip',
    chunkBytes: deps.readChunkBytes,
  })) {
    if (
      row.action_ref === record.action_ref &&
      !row.private_content_hash &&
      dotActionRecordHash(row) === record.private_content_hash
    ) {
      full = row;
      break;
    }
  }
  if (!full || JSON.stringify(full.scope) !== JSON.stringify(record.scope))
    throw new Error(
      '[DOT_ACTION_CONTENT_UNAVAILABLE] scoped action evidence missing or changed; do not execute the shared index'
    );
  assertDotActionJudgmentBinding(full);
  return full;
}

/** Streaming shared-index rows (constant memory, no size cap). */
function* iterateDotActionLedger(deps: DotActionLedgerDeps): Generator<DotActionRecord> {
  for (const row of streamJsonLines<DotActionRecord>(ledgerFile(deps), {
    onMalformed: 'skip',
    chunkBytes: deps.readChunkBytes,
  })) {
    if (typeof row?.action_ref !== 'string' || typeof row.dot_id !== 'string') continue;
    assertPrivateIndexHasNoJudgmentBody(row);
    yield !row.scope || (row.scope.tier !== 'public' && !row.private_content_hash)
      ? actionIndex(row)
      : row;
  }
}

export function readDotActionLedger(deps: DotActionLedgerDeps = {}): DotActionRecord[] {
  return [...iterateDotActionLedger(deps)];
}

function actionIndex(record: DotActionRecord): DotActionRecord {
  return {
    ...(record.scope ? { scope: record.scope } : {}),
    private_content_hash: dotActionRecordHash(record),
    action_ref: record.action_ref,
    dot_id: record.dot_id,
    actor_id: record.actor_id,
    action_id: record.action_id,
    title: '[scoped action]',
    objective: '[scoped action]',
    work_shape: record.work_shape,
    status: record.status,
    proposal_hash: record.proposal_hash,
    at: record.at,
    ...(record.work_item_id ? { work_item_id: record.work_item_id } : {}),
    ...(record.request_id ? { request_id: record.request_id } : {}),
    ...(record.handoff_to ? { handoff_to: record.handoff_to } : {}),
    ...(record.front_desk_execution ? { front_desk_execution: record.front_desk_execution } : {}),
  };
}
function actionLedgerLock(deps: DotActionLedgerDeps): string {
  return 'dot-action-ledger:' + createHash('sha256').update(ledgerFile(deps)).digest('hex');
}

/** Operator-reviewed adoption of old records; unknown scope is never public. */
export function migrateLegacyDotActions(
  charter: DotCharter,
  deps: DotActionLedgerDeps = {}
): number {
  if (!['sovereign', 'ecosystem_architect'].includes(resolvePolicyIdentityContext().persona))
    throw new Error(
      '[DOT_STATE_MIGRATION_AUTHORITY] action classification requires an authorized operator'
    );
  return withLockSync(actionLedgerLock(deps), () => {
    const file = ledgerFile(deps);
    const rows = [...streamJsonLines<DotActionRecord>(file, { chunkBytes: deps.readChunkBytes })];
    let migrated = 0;
    const rewritten = rows.map((row) => {
      if (row.dot_id !== charter.dot_id || row.private_content_hash || row.scope?.tier === 'public')
        return row;
      if (row.scope && JSON.stringify(row.scope) !== JSON.stringify(charter.scope))
        throw new Error(
          '[DOT_STATE_MIGRATION_SCOPE] inline action scope differs from reviewed charter'
        );
      const full = { ...row, scope: charter.scope };
      assertDotActionJudgmentBinding(full);
      const scopedFile = path.join(
        deps.rootDir ?? pathResolver.rootDir(),
        dotStatePath(charter, 'action-ledger.jsonl')
      );
      safeMkdir(path.dirname(scopedFile), { recursive: true });
      appendJsonLine(scopedFile, full);
      migrated++;
      return charter.scope.tier === 'public' ? full : actionIndex(full);
    });
    if (migrated) writeJsonLines(file, rewritten);
    return migrated;
  });
}

/** Strict retained history for a negative proof. Missing/malformed is never empty. */
export function readDotActionLedgerStrict(deps: DotActionLedgerDeps = {}): DotActionRecord[] {
  const file = assertSafeRepositoryPath(ledgerFile(deps), { allowMissingLeaf: false });
  const stat = safeLstat(file);
  // No size cap: the proof streams the full retained history, so a large
  // ledger never turns into a refusal (growth is warned at append time).
  if (!stat.isFile()) throw new Error('incomplete_action_evidence');
  const validateRow = (row: unknown): DotActionRecord => {
    if (!row || typeof row !== 'object' || Array.isArray(row))
      throw new Error('invalid_action_evidence');
    const value = row as Record<string, unknown>;
    assertPrivateIndexHasNoJudgmentBody(row as DotActionRecord);
    if (
      value.private_content_hash !== undefined &&
      (typeof value.private_content_hash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(value.private_content_hash))
    )
      throw new Error('invalid_action_evidence');
    if (!value.scope && !deps.indexOnly)
      throw new Error(
        '[DOT_STATE_MIGRATION_REQUIRED] legacy action evidence has no trustworthy scope'
      );
    if (
      ![
        'action_ref',
        'dot_id',
        'actor_id',
        'action_id',
        'title',
        'objective',
        'proposal_hash',
        'at',
      ].every((key) => typeof value[key] === 'string' && (value[key] as string).trim()) ||
      !Number.isFinite(Date.parse(value.at as string)) ||
      !['mission', 'task_session', 'pipeline', 'direct_reply'].includes(String(value.work_shape)) ||
      ![
        'admitted',
        'dispatched',
        'parked',
        'waiting_capacity',
        'refused',
        'shadow',
        'declined',
      ].includes(String(value.status)) ||
      !['decision', 'gate_decision', 'floor'].every(
        (key) =>
          value[key] === undefined || ['auto', 'notify', 'approve'].includes(String(value[key]))
      ) ||
      ![
        'request_id',
        'work_item_id',
        'handoff_to',
        'reason',
        'pipeline_ref',
        'target',
        'intent',
        'rationale',
        'disposition_by',
      ].every((key) => value[key] === undefined || typeof value[key] === 'string') ||
      (value.admission !== undefined && !isDotAdmissionIdentity(value.admission)) ||
      (value.admission_only !== undefined && typeof value.admission_only !== 'boolean') ||
      (value.gate_action_id !== undefined && typeof value.gate_action_id !== 'string') ||
      (value.front_desk_execution !== undefined &&
        !parseFrontDeskExecutionBinding(value.front_desk_execution)) ||
      (value.recovery_receipt !== undefined &&
        (!parseFrontDeskExecutionRecoveryReceipt(value.recovery_receipt) ||
          value.status !== 'declined'))
    )
      throw new Error('invalid_action_evidence');
    if (value.mission_admission !== undefined)
      parseMissionAdmissionRequest(value.mission_admission);
    const object = (entry: unknown): entry is Record<string, unknown> =>
      Boolean(entry && typeof entry === 'object' && !Array.isArray(entry));
    const link = (entry: unknown): boolean =>
      object(entry) && typeof entry.dot_id === 'string' && typeof entry.action_ref === 'string';
    if (
      (value.priority !== undefined &&
        !['low', 'normal', 'high', 'urgent'].includes(String(value.priority))) ||
      (value.expected_effect !== undefined &&
        (!object(value.expected_effect) ||
          !['increase', 'decrease', 'maintain'].includes(String(value.expected_effect.direction)) ||
          !['kr_id', 'signal'].every(
            (key) =>
              (value.expected_effect &&
                (value.expected_effect as Record<string, unknown>)[key] === undefined) ||
              typeof (value.expected_effect as Record<string, unknown>)[key] === 'string'
          ))) ||
      (value.superseded_by !== undefined && !link(value.superseded_by)) ||
      (value.escalation !== undefined &&
        (!object(value.escalation) ||
          typeof value.escalation.check_id !== 'string' ||
          typeof value.escalation.reason !== 'string' ||
          (value.escalation.link !== undefined && !link(value.escalation.link)) ||
          (value.escalation.links !== undefined &&
            (!Array.isArray(value.escalation.links) || !value.escalation.links.every(link)))))
    )
      throw new Error('invalid_action_evidence');
    if (value.recovery_receipt !== undefined) {
      const receipt = parseFrontDeskExecutionRecoveryReceipt(value.recovery_receipt)!;
      if (
        receipt.action_ref !== value.action_ref ||
        receipt.approval_request_id !== value.request_id ||
        recoveryEvidenceHash(receipt.binding) !== recoveryEvidenceHash(value.front_desk_execution)
      )
        throw new Error('invalid_recovery_action_evidence');
    }
    const record = row as DotActionRecord;
    if (record.private_content_hash === undefined) assertDotActionJudgmentBinding(record);
    const index =
      !record.scope || (record.scope.tier !== 'public' && !record.private_content_hash)
        ? actionIndex(record)
        : record;
    if (deps.indexOnly) return index;
    return hydratePrivateAction(index, deps);
  };
  const rows: DotActionRecord[] = [];
  for (const row of streamJsonLines<unknown>(file, { chunkBytes: deps.readChunkBytes })) {
    if (
      deps.dotId &&
      !(row && typeof row === 'object' && (row as { dot_id?: string }).dot_id === deps.dotId)
    )
      continue;
    rows.push(validateRow(row));
  }
  const after = safeLstat(file);
  if (after.ino !== stat.ino || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs)
    throw new Error('action_evidence_changed');
  return rows;
}
export function dotActionRecordHash(record: DotActionRecord): string {
  return recoveryEvidenceHash(record);
}
/** Only the authenticated recovery facade may supply this decision. Does not touch approval. */
export function declineRecoveredDotAction(
  expected: DotActionRecord,
  receipt: FrontDeskExecutionRecoveryReceipt,
  deps: DotActionLedgerDeps = {}
): DotActionRecord {
  const binding = expected.front_desk_execution;
  if (
    !binding ||
    !parseFrontDeskExecutionRecoveryReceipt(receipt) ||
    recoveryEvidenceHash(binding) !== recoveryEvidenceHash(receipt.binding) ||
    receipt.action_ref !== expected.action_ref ||
    receipt.approval_request_id !== expected.request_id
  )
    throw new Error('recovery_action_mismatch');
  return withFrontDeskDispatchLock(binding, () => {
    const request = readFrontDeskExecutionRecovery(binding);
    if (
      request.status !== 'terminated_unstarted' ||
      !request.recoveryReceipt ||
      !sameRecoveryReceipt(request.recoveryReceipt, receipt)
    )
      throw new Error('recovery_tombstone_required');
    const latest = readDotActionLedgerStrict({ ...deps, dotId: expected.dot_id })
      .filter((row) => row.action_ref === expected.action_ref)
      .at(-1);
    if (
      latest?.status === 'declined' &&
      latest.recovery_receipt &&
      sameRecoveryReceipt(latest.recovery_receipt, receipt)
    )
      return latest;
    if (
      !latest ||
      latest.status !== 'parked' ||
      latest.work_item_id ||
      dotActionRecordHash(latest) !== receipt.action_hash ||
      dotActionRecordHash(expected) !== receipt.action_hash
    )
      throw new Error('recovery_action_changed');
    assertUndispatchedWorkItemEvidenceHeld(binding, {
      actionRef: receipt.action_ref,
      approvalRequestId: receipt.approval_request_id,
    });
    appendActionRecord(
      {
        ...latest,
        status: 'declined',
        reason: 'terminated_unstarted',
        recovery_receipt: receipt,
        at: receipt.terminated_at,
      },
      deps
    );
    const readback = readDotActionLedgerStrict({ ...deps, dotId: expected.dot_id })
      .filter((row) => row.action_ref === expected.action_ref)
      .at(-1);
    if (
      readback?.status !== 'declined' ||
      !readback.recovery_receipt ||
      !sameRecoveryReceipt(readback.recovery_receipt, receipt)
    )
      throw new Error('recovery_action_readback_failed');
    return readback;
  });
}
export function appendActionRecord(
  record: DotActionRecord,
  deps: DotActionLedgerDeps
): DotActionRecord {
  if (!record.scope)
    throw new Error('[DOT_ACTION_SCOPE_REQUIRED] action writers must bind a trusted charter scope');
  dotStatePath({ scope: record.scope }); // Validate every declared tier/owner/tenant before persistence.
  assertDotActionJudgmentBinding(record);
  const write = () => {
    // A stale writer can never erase the terminal receipt or restore a parked row.
    const current = record.front_desk_execution
      ? currentDotActions(record.dot_id, deps).find((row) => row.action_ref === record.action_ref)
      : undefined;
    if (current?.recovery_receipt) return current;
    const filePath = ledgerFile(deps);
    safeMkdir(path.dirname(filePath), { recursive: true });
    if (record.private_content_hash !== undefined)
      throw new Error(
        '[DOT_ACTION_CONTENT_UNAVAILABLE] shared index cannot be appended as executable evidence'
      );
    if (record.scope && record.scope.tier !== 'public') {
      const scopedFile = path.join(
        deps.rootDir ?? pathResolver.rootDir(),
        dotStatePath({ scope: record.scope }, 'action-ledger.jsonl')
      );
      safeMkdir(path.dirname(scopedFile), { recursive: true });
      appendJsonLine(scopedFile, record);
      // Shared inventory carries no proposal prose, paths, private request
      // payload, or approval bindings. Full evidence must be read in scope.
      const index = actionIndex(record);
      appendJsonLine(filePath, index);
    } else appendJsonLine(filePath, record);
    warnOnLedgerGrowth(filePath, deps);
    return record;
  };
  const lockedWrite = () => withLockSync(actionLedgerLock(deps), write);
  return record.front_desk_execution
    ? withFrontDeskDispatchLock(record.front_desk_execution, lockedWrite)
    : lockedWrite();
}

/** Growth warns (P3) — never fails the append; the ledger has no automatic retention. */
function warnOnLedgerGrowth(filePath: string, deps: DotActionLedgerDeps): void {
  try {
    const threshold = deps.growthWarnBytes ?? DOT_ACTION_LEDGER_GROWTH_WARN_BYTES;
    const size = jsonlFileSize(filePath);
    if (size < Math.max(threshold, 2 * lastGrowthWarnBytes)) return;
    lastGrowthWarnBytes = size;
    logger.warn(
      `${DOT_ACTION_LEDGER_PATH} is ${size} bytes (warn threshold ${threshold}) — the ledger is replayed history with no automatic retention | next: review retention in storage-retention-catalog.json (entry is review_required) | evidence: ${filePath}`
    );
  } catch {
    // Observability only; the append already succeeded.
  }
}

/** Test seam: forget the growth-warn hysteresis. */
export function resetDotActionLedgerGrowthWarnForTests(): void {
  lastGrowthWarnBytes = 0;
}

/** Latest state per action_ref for one dot (insertion order preserved). */
export function currentDotActions(
  dotId: string,
  deps: DotActionLedgerDeps = {}
): DotActionRecord[] {
  const latest = new Map<string, DotActionRecord>();
  for (const row of iterateDotActionLedger(deps)) {
    if (row.dot_id === dotId) latest.set(row.action_ref, hydratePrivateAction(row, deps));
  }
  return [...latest.values()];
}

/**
 * Latest state per action_ref across every dot (insertion order preserved).
 * Callers comparing dots must apply their own tenant-scope filter.
 */
export function latestDotActions(deps: DotActionLedgerDeps = {}): DotActionRecord[] {
  const latest = new Map<string, DotActionRecord>();
  for (const row of iterateDotActionLedger(deps)) {
    try {
      latest.set(row.action_ref, hydratePrivateAction(row, deps));
    } catch {
      latest.set(row.action_ref, row);
    } // Inventory may retain counts/refs, never executable prose.
  }
  return [...latest.values()];
}

/** Observation integrity for `dot status` — never weaker than the data behind it. */
export type DotActionLedgerIntegrity = 'complete' | 'partial' | 'integrity_error';

export interface DotActionObservation {
  /**
   * complete        — every index row for this dot parsed and its scoped
   *                   evidence hydrated.
   * partial         — the index parsed, but some of this dot's rows live in a
   *                   scope this process may not hydrate (another tenant or
   *                   personal owner). Counts remain trustworthy for the
   *                   visible rows only.
   * integrity_error — malformed index lines/rows, an invalid private index
   *                   shape, or missing/changed scoped evidence. Also used
   *                   when the shared index itself could not be read — then
   *                   `anomalies` is null because even the totals are unknown.
   */
  integrity: DotActionLedgerIntegrity;
  /** Hydrated records for `dotId` (private evidence read in scope). */
  actions: DotActionRecord[];
  /**
   * Well-formed index rows whose scoped evidence is missing or changed.
   * Metadata only — they carry no private prose and are never executable.
   */
  index_only: DotActionRecord[];
  /**
   * Anomaly counts within the caller's visible scope. Refused-row contents
   * and ids of invisible scopes are never returned — `not_visible` is a count
   * only. Null when the shared index itself was unreadable (the count is
   * unknown, never zero-filled).
   */
  anomalies: { malformed_rows: number; missing_evidence: number; not_visible: number } | null;
  /** Reviewed repair entry points; observation never rewrites the ledger. */
  repair: string[];
}

const DOT_ACTION_OBSERVATION_REPAIR = {
  malformed:
    'the shared action index has malformed rows; have an authorized operator review the owning scope — pnpm kyberion dot migrate-state <dot_id> --legacy-tier <tier> --apply adopts legacy records only after review',
  missing:
    'scoped action evidence is missing or changed; restore it inside the owning scope or have the owner confirm a decline — the shared index must never be executed',
  invisible:
    "some of this dot's rows live outside this process scope; inspect them under the owning tenant/owner identity — status never widens permissions to read them",
} as const;

/** Why a hydrate was refused — decides anomaly kind without exposing row content. */
function hydrateRefusalKind(error: unknown): 'malformed' | 'missing_evidence' | 'not_visible' {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.includes('invalid private content identity') ||
    message.includes('invalid private index scope')
  )
    return 'malformed';
  if (message.includes('missing or changed')) return 'missing_evidence';
  // DOT_PERSONAL_OWNER, secure-io denials and anything unrecognized: the row
  // claims a scope this process cannot verify — treat as not visible rather
  // than as absent.
  return 'not_visible';
}

/**
 * Read-only observation of one dot's action ledger for `dot status`.
 *
 * Execution callers keep the strict `currentDotActions` hydrate: it refuses
 * the whole set on a single bad row, which is correct for dispatch but made a
 * status view die on unrelated corruption. This observer separates the two:
 * visible-scope rows are still summarized at index level, anomalies are
 * counted (never silently skipped into 'healthy'), and rows in an invisible
 * scope contribute a count only — their contents and ids never leave this
 * function. The ledger is never written here; `repair` points at the
 * reviewed migration / owner-confirmation paths.
 */
export function observeDotActions(
  dotId: string,
  deps: DotActionLedgerDeps = {}
): DotActionObservation {
  const file = ledgerFile(deps);
  let malformed = 0;
  const unreadable = (): DotActionObservation => ({
    integrity: 'integrity_error',
    actions: [],
    index_only: [],
    anomalies: null,
    repair: [
      "the shared action index could not be read, so even row counts are unknown — check this process's scope, then re-run status under an identity that may read it",
    ],
  });
  let rows: Iterator<DotActionRecord>;
  try {
    rows = streamJsonLines<DotActionRecord>(file, {
      chunkBytes: deps.readChunkBytes,
      onMalformed: () => {
        malformed += 1;
      },
    })[Symbol.iterator]();
  } catch {
    return unreadable();
  }
  const latest = new Map<string, DotActionRecord>();
  const indexOnly = new Map<string, DotActionRecord>();
  let missingEvidence = 0;
  let notVisible = 0;
  for (;;) {
    // Only a failure to read the index itself is "unreadable"; per-row
    // hydrate failures are counted below.
    let next: IteratorResult<DotActionRecord>;
    try {
      next = rows.next();
    } catch {
      return unreadable();
    }
    if (next.done) break;
    const row = next.value;
    if (!row || typeof row.action_ref !== 'string' || typeof row.dot_id !== 'string') {
      malformed += 1;
      continue;
    }
    if (row.dot_id !== dotId) continue;
    const index =
      !row.scope || (row.scope.tier !== 'public' && !row.private_content_hash)
        ? actionIndex(row)
        : row;
    try {
      latest.set(row.action_ref, hydratePrivateAction(index, deps));
      indexOnly.delete(row.action_ref);
    } catch (error) {
      const kind = hydrateRefusalKind(error);
      if (kind === 'malformed') {
        malformed += 1;
        indexOnly.delete(row.action_ref);
      } else if (kind === 'missing_evidence') {
        missingEvidence += 1;
        if (!latest.has(row.action_ref)) indexOnly.set(row.action_ref, index);
      } else {
        notVisible += 1;
        indexOnly.delete(row.action_ref);
      }
    }
  }
  const integrity: DotActionLedgerIntegrity =
    malformed > 0 || missingEvidence > 0
      ? 'integrity_error'
      : notVisible > 0
        ? 'partial'
        : 'complete';
  const repair: string[] = [];
  if (malformed > 0) repair.push(DOT_ACTION_OBSERVATION_REPAIR.malformed);
  if (missingEvidence > 0) repair.push(DOT_ACTION_OBSERVATION_REPAIR.missing);
  if (notVisible > 0) repair.push(DOT_ACTION_OBSERVATION_REPAIR.invisible);
  return {
    integrity,
    actions: [...latest.values()],
    index_only: [...indexOnly.values()],
    anomalies: {
      malformed_rows: malformed,
      missing_evidence: missingEvidence,
      not_visible: notVisible,
    },
    repair,
  };
}

/** Identity of a proposal for dedupe: includes pipeline, target and intent so opposing proposals never collapse. */
export function dotProposalHash(dotId: string, proposal: DotProposal): string {
  const judgment = validateServerDotJudgmentProposal(proposal);
  return createHash('sha256')
    .update(
      JSON.stringify([
        dotId,
        proposal.action_id,
        proposal.title,
        proposal.objective,
        ...(proposal.front_desk_execution ? [proposal.front_desk_execution] : []),
        ...(proposal.continuous_work ? [proposal.continuous_work] : []),
        proposal.handoff_to ?? '',
        // Appended only when set, so hashes of proposals without these fields
        // (and their dedupe windows) are unchanged.
        ...(proposal.pipeline_ref || proposal.target || proposal.intent
          ? [proposal.pipeline_ref ?? '', proposal.target ?? '', proposal.intent ?? '']
          : []),
        ...(judgment ? ['semantic-judgment-v1', judgmentCanonicalHash(judgment)] : []),
      ])
    )
    .digest('hex')
    .slice(0, 16);
}
