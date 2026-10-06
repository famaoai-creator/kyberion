/** Durable action snapshots and bounded terminal append, independent of dot orchestration. */
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { pathResolver } from '../path-resolver.js';
import { safeMkdir, safeLstat, assertSafeRepositoryPath } from '../secure-io.js';
import { appendJsonLine, readJsonLines } from '../foundation/json.js';
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
export const DOT_ACTION_LEDGER_PATH = 'active/shared/runtime/dot-action-ledger.jsonl';
export interface DotActionLedgerDeps {
  rootDir?: string;
  now?: () => Date;
}

export type DotActionStatus = 'dispatched' | 'parked' | 'refused' | 'shadow' | 'declined';

export interface DotActionRecord {
  recovery_receipt?: FrontDeskExecutionRecoveryReceipt;
  front_desk_execution?: FrontDeskExecutionBinding;
  action_ref: string;
  dot_id: string;
  actor_id: string;
  action_id: string;
  title: string;
  objective: string;
  work_shape: DotWorkShape;
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

function ledgerFile(deps: DotActionLedgerDeps): string {
  return path.join(deps.rootDir ?? pathResolver.rootDir(), DOT_ACTION_LEDGER_PATH);
}

export function readDotActionLedger(deps: DotActionLedgerDeps = {}): DotActionRecord[] {
  return readJsonLines<DotActionRecord>(ledgerFile(deps), { onMalformed: 'skip' }).filter(
    (row) => typeof row?.action_ref === 'string' && typeof row.dot_id === 'string'
  );
}

/** Strict retained history for a negative proof. Missing/malformed is never empty. */
export function readDotActionLedgerStrict(deps: DotActionLedgerDeps = {}): DotActionRecord[] {
  const file = assertSafeRepositoryPath(ledgerFile(deps), { allowMissingLeaf: false });
  const stat = safeLstat(file);
  if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error('incomplete_action_evidence');
  const rows = readJsonLines<unknown>(file).map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row))
      throw new Error('invalid_action_evidence');
    const value = row as Record<string, unknown>;
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
      !['dispatched', 'parked', 'refused', 'shadow', 'declined'].includes(String(value.status)) ||
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
      (value.front_desk_execution !== undefined &&
        !parseFrontDeskExecutionBinding(value.front_desk_execution)) ||
      (value.recovery_receipt !== undefined &&
        (!parseFrontDeskExecutionRecoveryReceipt(value.recovery_receipt) ||
          value.status !== 'declined'))
    )
      throw new Error('invalid_action_evidence');
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
    return row as DotActionRecord;
  });
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
    const latest = readDotActionLedgerStrict(deps)
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
    const readback = readDotActionLedgerStrict(deps)
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
  const write = () => {
    // A stale writer can never erase the terminal receipt or restore a parked row.
    const current = record.front_desk_execution
      ? currentDotActions(record.dot_id, deps).find((row) => row.action_ref === record.action_ref)
      : undefined;
    if (current?.recovery_receipt) return current;
    const filePath = ledgerFile(deps);
    safeMkdir(path.dirname(filePath), { recursive: true });
    appendJsonLine(filePath, record);
    return record;
  };
  return record.front_desk_execution
    ? withFrontDeskDispatchLock(record.front_desk_execution, write)
    : write();
}

/** Latest state per action_ref for one dot (insertion order preserved). */
export function currentDotActions(
  dotId: string,
  deps: DotActionLedgerDeps = {}
): DotActionRecord[] {
  const latest = new Map<string, DotActionRecord>();
  for (const row of readDotActionLedger(deps)) {
    if (row.dot_id === dotId) latest.set(row.action_ref, row);
  }
  return [...latest.values()];
}

/**
 * Latest state per action_ref across every dot (insertion order preserved).
 * Callers comparing dots must apply their own tenant-scope filter.
 */
export function latestDotActions(deps: DotActionLedgerDeps = {}): DotActionRecord[] {
  const latest = new Map<string, DotActionRecord>();
  for (const row of readDotActionLedger(deps)) latest.set(row.action_ref, row);
  return [...latest.values()];
}

/** Identity of a proposal for dedupe: includes pipeline, target and intent so opposing proposals never collapse. */
export function dotProposalHash(dotId: string, proposal: DotProposal): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        dotId,
        proposal.action_id,
        proposal.title,
        proposal.objective,
        ...(proposal.front_desk_execution ? [proposal.front_desk_execution] : []),
        proposal.handoff_to ?? '',
        // Appended only when set, so hashes of proposals without these fields
        // (and their dedupe windows) are unchanged.
        ...(proposal.pipeline_ref || proposal.target || proposal.intent
          ? [proposal.pipeline_ref ?? '', proposal.target ?? '', proposal.intent ?? '']
          : []),
      ])
    )
    .digest('hex')
    .slice(0, 16);
}
