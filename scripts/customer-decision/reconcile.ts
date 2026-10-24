/**
 * Completion and recovery of respond runs from their write-ahead journal (all under the case lock).
 * Part of scripts/customer_decision.ts (the entry point); see its header.
 */
import { logger } from '@agent/core/core';
import { auditChain } from '@agent/core/governance/audit-chain';
import {
  readLedger,
  type DecisionLedgerLocation,
  type DecisionRecord,
} from '@agent/core/decision-ledger';
import {
  appendSwitches,
  detectSwitches,
  isActiveCustomerDecision,
  listRespondJournals,
  newSwitchId,
  projectBriefInput,
  readAgenda,
  readReceipt,
  readSwitches,
  removeRespondJournal,
  resolveAgendaEffective,
  writeBriefInput,
  writeReceipt,
  writeRespondJournal,
  type DecisionAgenda,
  type DecisionReceipt,
  type DecisionSwitch,
  type RespondJournalRecord,
} from '@agent/core/customer-decision';
import {
  AUDIT_AGENT,
  asLedgerWriter,
  diagnosticCode,
  auditFailure,
  noteDealSwitches,
} from './common.js';

export function recordRespondAudit(
  tenant: string,
  agenda: DecisionAgenda,
  receipt: DecisionReceipt,
  recovered: boolean
): void {
  auditChain.record({
    agentId: AUDIT_AGENT,
    action: 'customer_decision',
    operation: 'respond',
    result: 'completed',
    tenantSlug: tenant,
    metadata: {
      agenda_id: agenda.agenda_id,
      case_id: agenda.case_id,
      content_hash: receipt.content_hash,
      invite_id: receipt.invite_id,
      receipt_id: receipt.receipt_id,
      participant_role: receipt.participant.role,
      actor_id: receipt.participant.actor_id,
      identity_assurance: receipt.identity_assurance,
      decision_ids: receipt.decision_ids,
      change_requests: receipt.answers
        .filter((answer) => answer.outcome === 'change_request')
        .map((answer) => answer.entry_id),
      ...(recovered ? { recovered: true } : {}),
    },
  });
}

/**
 * Is the `respond completed` audit entry of this receipt already in the chain?
 * Read only for a run found at stage `auditing` (cut off around the audit
 * append), so the normal path never scans the chain.
 */
export function respondAuditRecorded(tenant: string, receiptId: string): boolean {
  return auditChain
    .loadAll()
    .some(
      (entry) =>
        entry.action === 'customer_decision' &&
        entry.operation === 'respond' &&
        entry.result === 'completed' &&
        entry.tenantSlug === tenant &&
        entry.metadata?.receipt_id === receiptId
    );
}

/**
 * Finish a respond run whose ledger step is done: receipt (if missing) →
 * audit → switches (only those not yet recorded for this receipt) → brief
 * input → remove the journal record. Every step is idempotent, so a run cut
 * off anywhere completes on retry: the journal moves to `auditing` before the
 * audit append and to `audited` after it, and a run found at `auditing`
 * records the audit entry only if the chain does not hold it yet (one
 * `respond completed` entry per receipt). Runs as the ledger writer, under the lock.
 */
export function completeRespond(
  tenant: string,
  location: DecisionLedgerLocation,
  agenda: DecisionAgenda,
  start: RespondJournalRecord,
  now: string,
  recovered: boolean
): { receiptId: string; switches: DecisionSwitch[]; appended: DecisionSwitch[] } {
  let journal = start;
  const advance = (stage: RespondJournalRecord['stage']) => {
    journal = writeRespondJournal(location, { ...journal, stage, updated_at: now });
  };
  if (journal.stage === 'planned') advance('ledger_written');
  const receipt =
    readReceipt(location, journal.receipt_id) ?? writeReceipt(location, journal.receipt);
  if (journal.stage === 'ledger_written') advance('receipt_written');
  if (journal.stage === 'receipt_written' || journal.stage === 'auditing') {
    const alreadyAudited =
      journal.stage === 'auditing' && respondAuditRecorded(tenant, receipt.receipt_id);
    if (journal.stage === 'receipt_written') advance('auditing');
    if (!alreadyAudited) recordRespondAudit(tenant, agenda, receipt, recovered);
    advance('audited');
  }
  const after = resolveAgendaEffective(agenda, readLedger(location), { now });
  const recorded = readSwitches(location, { agendaId: agenda.agenda_id }).filter(
    (item) => item.cause_receipt_id === receipt.receipt_id
  );
  const recordedEntries = new Set(recorded.map((item) => item.entry_id));
  const appended = appendSwitches(
    location,
    detectSwitches(journal.before, after, {
      case_id: agenda.case_id,
      agenda_id: agenda.agenda_id,
      now,
      cause_receipt_id: receipt.receipt_id,
      newId: newSwitchId,
    }).filter((item) => !recordedEntries.has(item.entry_id))
  );
  writeBriefInput(location, projectBriefInput(agenda, after, now));
  removeRespondJournal(location, journal.receipt_id);
  return { receiptId: receipt.receipt_id, switches: [...recorded, ...appended], appended };
}

export interface ReconcileReport {
  completed: string[];
  abandoned: string[];
  stuck: Array<{ receipt_id: string; reason: string }>;
}

/**
 * Complete (or drop) the respond runs of a case that stopped part way, from
 * their journal records. Call holding the case lock, before any new write.
 *   - ledger written (every pre-assigned decision id is in the ledger with
 *     this receipt as its evidence), or nothing to append → complete it;
 *   - still `planned` and none of the ids in the ledger → the run never wrote
 *     anything: drop the record (audited as `respond` failed / not_applied);
 *   - anything else (ids taken by other records) → left in place, reported.
 * Each record is handled on its own: an error on one (an unreadable agenda, a
 * store refusal) is reported in `stuck` with its diagnostic code and audited
 * as `respond_reconcile` failed, and the next record is still handled — one
 * bad record never blocks the case, a new respond or `status`.
 */
export function reconcileCase(
  tenant: string,
  location: DecisionLedgerLocation,
  now: string
): ReconcileReport {
  return asLedgerWriter(tenant, () => {
    const report: ReconcileReport = { completed: [], abandoned: [], stuck: [] };
    const journals = listRespondJournals(location, (receiptId, error) => {
      const code = diagnosticCode(error);
      report.stuck.push({ receipt_id: receiptId, reason: code });
      auditFailure(tenant, 'respond_reconcile', code, { receipt_id: receiptId });
    });
    for (const journal of journals) {
      try {
        reconcileJournal(tenant, location, journal, now, report);
      } catch (error) {
        const code = diagnosticCode(error);
        report.stuck.push({ receipt_id: journal.receipt_id, reason: code });
        auditFailure(tenant, 'respond_reconcile', code, {
          agenda_id: journal.agenda_id,
          receipt_id: journal.receipt_id,
          stage: journal.stage,
        });
      }
    }
    if (report.stuck.length > 0) {
      logger.warn(
        `customer-decision respond journal not reconciled — ${report.stuck.map((item) => `${item.receipt_id}:${item.reason}`).join(', ')} | inspect <case>/respond-journal/ and the ledger | customer_decision status`
      );
    }
    return report;
  });
}

/** One journal record of {@link reconcileCase}; throws are caught by the caller. */
export function reconcileJournal(
  tenant: string,
  location: DecisionLedgerLocation,
  journal: RespondJournalRecord,
  now: string,
  report: ReconcileReport
): void {
  const agenda = readAgenda(location, journal.agenda_id);
  if (!agenda) {
    report.stuck.push({ receipt_id: journal.receipt_id, reason: 'agenda_missing' });
    return;
  }
  const ledger = readLedger(location);
  const ids = journal.receipt.decision_ids;
  const applied = ids.filter((id) =>
    ledger.some(
      (record) =>
        record.id === id && record.decided_by?.on_behalf_of?.evidence === journal.receipt_id
    )
  );
  if (journal.stage === 'planned' && ids.length > 0 && applied.length === 0) {
    removeRespondJournal(location, journal.receipt_id);
    auditFailure(tenant, 'respond', 'not_applied', {
      agenda_id: journal.agenda_id,
      receipt_id: journal.receipt_id,
      invite_id: journal.receipt.invite_id,
    });
    report.abandoned.push(journal.receipt_id);
    return;
  }
  if (applied.length !== ids.length) {
    report.stuck.push({ receipt_id: journal.receipt_id, reason: 'ledger_mismatch' });
    return;
  }
  const done = completeRespond(tenant, location, agenda, journal, now, true);
  noteDealSwitches(tenant, agenda, done.appended);
  report.completed.push(journal.receipt_id);
}

/**
 * Customer decisions of this agenda whose evidence receipt does not exist and
 * that no journal record can complete (written outside the facade, or lost).
 */
export function unreconciledDecisions(
  agenda: DecisionAgenda,
  ledger: readonly DecisionRecord[],
  receiptIds: ReadonlySet<string>,
  pending: ReadonlySet<string>
): string[] {
  return ledger
    .filter((record) => {
      if (!isActiveCustomerDecision(record)) return false;
      if (!record.basis?.some((basis) => basis.ref === `agenda:${agenda.agenda_id}`)) return false;
      const evidence = String(record.decided_by?.on_behalf_of?.evidence ?? '');
      return !receiptIds.has(evidence) && !pending.has(evidence);
    })
    .map((record) => record.id);
}
