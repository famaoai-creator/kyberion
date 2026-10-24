/**
 * CD-09 "実装中の判断を顧客に回す": the operator's side of task proposals.
 * Part of scripts/customer_decision.ts (the entry point); see its header.
 *
 *   draft --from-tasks   collect the customer-judgment questions mission tasks
 *                        recorded on their consumer locks into a draft agenda
 *                        (new, or `--agenda <draft>`); submit / send as usual.
 *   status               lists pending proposals and held tasks (taskProposalStatus).
 *
 * Mission workers only write their own lock (narrow consumer store role); the
 * agenda is written here, as the facade's decision_ledger role, which also
 * links each collected proposal back to its agenda entry on the lock, so a
 * proposal is collected once.
 */
import { logger } from '@agent/core/core';
import { t } from '@agent/core/t';
import {
  CUSTOMER_SLUG_PATTERN,
  readLedger,
  type DecisionLedgerLocation,
} from '@agent/core/decision-ledger';
import {
  agendaContentHash,
  listAgendas,
  listConsumedDecisionLocks,
  newAgendaId,
  openAgendas,
  pendingTaskProposals,
  taskProposalAgendaEntry,
  taskProposalHolds,
  writeAgenda,
  writeConsumedDecisionLock,
  type AgendaEntry,
  type ConsumedDecisionLockRecord,
  type DecisionAgenda,
  type TaskProposalLockEntry,
} from '@agent/core/customer-decision';
import { ScriptExitError } from '../lib/harness.js';
import {
  agendaSummary,
  asLedgerWriter,
  assertUniqueEntries,
  audit,
  diagnosticCode,
  itemKey,
  loadAgenda,
  locationOf,
  requireOpt,
  tenantOf,
  usageError,
  withCaseLock,
} from './common.js';

const TASK_PROPOSAL_PHASE = 'construction';

function readLocks(location: DecisionLedgerLocation): ConsumedDecisionLockRecord[] {
  return listConsumedDecisionLocks(location, (consumer, error) =>
    logger.warn(
      `customer-decision task proposals: consumer lock skipped — ${diagnosticCode(error)} | the other locks are read; repair or remove the lock | ${consumer}`
    )
  );
}

interface PendingProposal {
  lock: ConsumedDecisionLockRecord;
  entry: TaskProposalLockEntry;
}

/**
 * `draft --tenant <t> --case <c> --from-tasks [--agenda <draft>] [--customer <slug>]`:
 * every task proposal no agenda carries yet becomes an entry of the target
 * draft agenda (our decision = the task's proposal; a requires_customer
 * question carries none). A question an open agenda already asks is linked
 * to that entry instead. Each proposal is linked back on its lock, so a
 * second run adds nothing.
 */
export function runCollectTaskProposals(opts: Record<string, string>, now: string): unknown {
  const tenant = tenantOf(opts);
  const caseId = requireOpt(opts, 'case');
  const location = locationOf(opts, caseId);
  return withCaseLock(location, () =>
    asLedgerWriter(tenant, () => collectLocked(opts, now, tenant, caseId, location))
  );
}

function collectLocked(
  opts: Record<string, string>,
  now: string,
  tenant: string,
  caseId: string,
  location: DecisionLedgerLocation
): unknown {
  const target = opts.agenda ? loadAgenda(location, tenant, opts.agenda) : undefined;
  if (target && target.status !== 'draft') {
    throw new ScriptExitError(
      2,
      `agenda ${target.agenda_id} is ${target.status}; --from-tasks adds to a draft agenda only (omit --agenda to start a new one)`
    );
  }
  const pending: PendingProposal[] = readLocks(location)
    .flatMap((lock) => pendingTaskProposals(lock).map((entry) => ({ lock, entry })))
    .sort(
      (a, b) =>
        a.entry.proposal.proposed_at.localeCompare(b.entry.proposal.proposed_at) ||
        a.lock.consumer.localeCompare(b.lock.consumer)
    );
  if (pending.length === 0) {
    return { case_id: caseId, agenda_id: target?.agenda_id ?? null, collected: 0, added: 0 };
  }
  const agendaId = target?.agenda_id ?? newAgendaId();
  const others = openAgendas(listAgendas(location)).filter(
    (agenda) => agenda.agenda_id !== agendaId
  );
  const entries: AgendaEntry[] = [...(target?.entries ?? [])];
  const links = new Map<string, { agenda_id: string; entry_id: string }>();
  let added = 0;
  let linkedExisting = 0;
  for (const { entry } of pending) {
    const pair = itemKey(entry);
    const elsewhere = others
      .map((agenda) => ({
        agenda,
        asked: agenda.entries.find((candidate) => itemKey(candidate) === pair),
      }))
      .find((candidate) => candidate.asked);
    if (elsewhere?.asked) {
      links.set(entry.proposal.proposal_id, {
        agenda_id: elsewhere.agenda.agenda_id,
        entry_id: elsewhere.asked.entry_id,
      });
      linkedExisting += 1;
      continue;
    }
    const here = entries.find((candidate) => itemKey(candidate) === pair);
    if (!here) {
      const created = taskProposalAgendaEntry(entry);
      entries.push(created);
      added += 1;
    }
    links.set(entry.proposal.proposal_id, {
      agenda_id: agendaId,
      entry_id: here?.entry_id ?? entry.proposal.proposal_id,
    });
  }

  let written: DecisionAgenda | undefined = target;
  if (added > 0) {
    assertUniqueEntries(entries);
    if (target) {
      written = writeAgenda(location, { ...target, entries, updated_at: now });
    } else {
      const customer = opts.customer?.trim();
      if (!customer || !CUSTOMER_SLUG_PATTERN.test(customer)) {
        throw usageError('--customer <slug> is required to start a new agenda from task proposals');
      }
      // i18n-exempt: validates the --locale flag against the agenda schema's ja|en enum, not a UI branch
      const locale = opts.locale === 'en' ? 'en' : 'ja';
      written = writeAgenda(location, {
        version: '1.0.0',
        agenda_id: agendaId,
        tenant_slug: tenant,
        case_id: caseId,
        customer,
        title:
          opts.title?.trim() ||
          t('customer_decision:task_proposals_agenda_title', undefined, locale),
        ...(opts.from?.trim() ? { from: opts.from.trim() } : {}),
        phase: TASK_PROPOSAL_PHASE,
        revision: 1,
        locale,
        ...(opts.deal ? { deal_id: opts.deal } : {}),
        ...(opts.project ? { project_id: opts.project } : {}),
        entries,
        status: 'draft',
        created_at: now,
        updated_at: now,
      });
    }
  }

  // Link each proposal back on its lock: it is collected once.
  const consumers = [...new Set(pending.map((item) => item.lock.consumer))];
  for (const consumer of consumers) {
    const lock = pending.find((item) => item.lock.consumer === consumer)!.lock;
    writeConsumedDecisionLock(location, {
      ...lock,
      decisions: lock.decisions.map((decision) => {
        const link =
          decision.layer === 'task_proposal' && decision.proposal && !decision.agenda_id
            ? links.get(decision.proposal.proposal_id)
            : undefined;
        return link && decision.proposal
          ? { ...decision, ...link, proposal: { ...decision.proposal, collected_at: now } }
          : decision;
      }),
    });
  }
  const proposalIds = [...links.keys()].sort();
  audit(tenant, 'task_proposals_collect', {
    case_id: caseId,
    agenda_id: written?.agenda_id ?? null,
    proposal_ids: proposalIds,
    added,
    linked_existing: linkedExisting,
    consumers,
    ...(written ? { content_hash: agendaContentHash(written) } : {}),
  });
  return {
    ...(written ? agendaSummary(written) : { case_id: caseId, agenda_id: null }),
    collected: links.size,
    added,
    linked_existing: linkedExisting,
    proposal_ids: proposalIds,
    ...(written && added > 0
      ? {
          next: `pnpm kyberion customer-decision submit --tenant ${tenant} --case ${caseId} --agenda ${written.agenda_id} --by user:<member>`,
        }
      : {}),
  };
}

/**
 * The task proposal part of `status`: pending proposals (not on an agenda
 * yet) and tasks holding on a requires_customer question, each `awaiting` or
 * `resolved` (every held question has a confirmed customer decision; resume
 * the mission to re-run the task). Ids and counts; call as the ledger writer.
 */
export function taskProposalStatus(
  tenant: string,
  caseId: string,
  location: DecisionLedgerLocation,
  now: string
): Record<string, unknown> {
  const locks = readLocks(location);
  const pending = locks.flatMap((lock) =>
    pendingTaskProposals(lock).map((entry) => entry.proposal.proposal_id)
  );
  const held = locks.filter((lock) => lock.hold && lock.status === 'in_progress');
  const agendas = held.length > 0 ? listAgendas(location) : [];
  const ledger = held.length > 0 ? readLedger(location) : [];
  const holds = held.map((lock) => {
    const proposals = taskProposalHolds(lock, agendas, ledger, now);
    const resolved = proposals.length > 0 && proposals.every((hold) => hold.resolved_decision_id);
    return {
      consumer: lock.consumer,
      mission_id: lock.mission_id,
      task_id: lock.task_id,
      ...(lock.hold?.work_item_id ? { work_item_id: lock.hold.work_item_id } : {}),
      status: resolved ? 'resolved' : 'awaiting',
      proposal_ids: proposals.map((hold) => hold.proposal_id),
      uncollected: proposals.filter((hold) => !hold.collected).length,
      decision_ids: proposals.flatMap((hold) =>
        hold.resolved_decision_id ? [hold.resolved_decision_id] : []
      ),
      ...(resolved ? { next: `pnpm mission resume ${lock.mission_id}` } : {}),
    };
  });
  return {
    pending: { count: pending.length, proposal_ids: pending.sort() },
    awaiting_customer: holds,
    ...(pending.length > 0
      ? {
          next: `pnpm kyberion customer-decision draft --tenant ${tenant} --case ${caseId} --from-tasks --customer <slug>`,
        }
      : {}),
  };
}
