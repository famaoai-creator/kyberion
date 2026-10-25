/**
 * CD-09 "実装中の判断を顧客に回す": the operator's side of task proposals.
 * Part of scripts/customer_decision.ts (the entry point); see its header.
 *
 *   draft --from-tasks   collect the customer-judgment questions mission tasks
 *                        recorded on their consumer locks into a draft agenda
 *                        (new, or `--agenda <draft>`); submit / send as usual.
 *   draft --from-tasks --reask <tp-id,...> --by user:<member>
 *                        ask again a requires_customer question whose agenda
 *                        was closed, withdrawn or lost with no confirmed answer
 *                        (unresolvable): it goes on a draft agenda like a
 *                        pending one, and its lock moves the old link to
 *                        `previous_links`.
 *   status               lists pending proposals and held tasks (taskProposalStatus).
 *
 * Mission workers only write their own lock (narrow consumer store role); the
 * agenda is written here, as the facade's decision_ledger role, which also
 * links each collected proposal back to its agenda entry on the lock, so a
 * proposal is collected once. A re-ask writes the agenda first, then each
 * lock as the content-checked consumer store role (owner-bound capability),
 * so the tier guard holds the relink to its rule (`taskProposalRelinkProblem`).
 *
 * A re-asked question may surface the customer's earlier, never-confirmed
 * answer on the same item × key as awaiting the operator's confirmation on
 * the new agenda (customer answers are case-wide); the operator may confirm
 * it (CD-09 human decision 2026-10-26).
 */
import { logger } from '@agent/core/core';
import { t } from '@agent/core/t';
import {
  CUSTOMER_SLUG_PATTERN,
  readLedger,
  type DecisionLedgerLocation,
} from '@agent/core/decision-ledger';
import {
  TASK_PROPOSAL_ID_PATTERN,
  agendaContentHash,
  asCustomerDecisionConsumerOwner,
  listAgendas,
  listConsumedDecisionLocks,
  newAgendaId,
  openAgendas,
  pendingTaskProposals,
  readConsumedDecisionLock,
  relinkTaskProposal,
  taskProposalAgendaEntry,
  taskProposalHolds,
  taskProposalsOf,
  unresolvableTaskProposals,
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
  memberActorId,
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

/** Locks a boundary still acts on: a superseded task's lock is frozen. */
function activeLocks(location: DecisionLedgerLocation): ConsumedDecisionLockRecord[] {
  return readLocks(location).filter((lock) => !lock.superseded);
}

/**
 * An entry that must wait for the customer: `requires_customer`, and (per the
 * agenda schema) no decision of ours and no organization default under it.
 */
function requireCustomer(entry: AgendaEntry): AgendaEntry {
  const { our_decision: _ours, org_default: _default, ...rest } = entry;
  void _ours;
  void _default;
  return { ...rest, requires_customer: true };
}

interface PendingProposal {
  lock: ConsumedDecisionLockRecord;
  entry: TaskProposalLockEntry;
}

const isClosed = (agenda: DecisionAgenda | undefined): boolean =>
  !agenda || agenda.status === 'closed' || agenda.status === 'withdrawn';

/**
 * `draft --tenant <t> --case <c> --from-tasks [--agenda <draft>] [--customer <slug>]`:
 * every task proposal no agenda carries yet becomes an entry of the target
 * draft agenda (our decision = the task's proposal; a requires_customer
 * question carries none). A question an open agenda already asks is linked
 * to that entry instead. Each proposal is linked back on its lock, so a
 * second run adds nothing. With `--reask <tp-id,...> --by user:<member>` the
 * listed unresolvable proposals are collected again the same way (see the
 * module header); every listed id must be unresolvable or already re-asked.
 */
export function runCollectTaskProposals(opts: Record<string, string>, now: string): unknown {
  const tenant = tenantOf(opts);
  const caseId = requireOpt(opts, 'case');
  const location = locationOf(opts, caseId);
  const reask = opts.reask !== undefined ? reaskRequest(opts) : undefined;
  return withCaseLock(location, () =>
    asLedgerWriter(tenant, () => collectLocked(opts, now, tenant, caseId, location, reask))
  );
}

interface ReaskRequest {
  proposalIds: string[];
  by: string;
}

function reaskRequest(opts: Record<string, string>): ReaskRequest {
  const proposalIds = [
    ...new Set(
      opts.reask
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean)
    ),
  ];
  if (proposalIds.length === 0 || !proposalIds.every((id) => TASK_PROPOSAL_ID_PATTERN.test(id))) {
    throw usageError('--reask takes task proposal ids (tp-<hex16>, comma-separated)');
  }
  return { proposalIds: proposalIds.sort(), by: memberActorId(opts.by) };
}

/**
 * The proposals a re-ask collects again: each listed id must be one a task
 * still holds on with nothing left to release it (unresolvable). One already
 * re-asked onto an open agenda is reported, not collected twice (idempotent
 * re-run); anything else is refused (exit 2) before anything is written.
 */
function reaskCandidates(
  location: DecisionLedgerLocation,
  request: ReaskRequest,
  now: string
): { pending: PendingProposal[]; already: string[] } {
  const locks = readLocks(location);
  const agendas = listAgendas(location);
  const ledger = readLedger(location);
  const byId = new Map(agendas.map((agenda) => [agenda.agenda_id, agenda]));
  const pending: PendingProposal[] = [];
  const already: string[] = [];
  for (const id of request.proposalIds) {
    const lock = locks.find((candidate) =>
      taskProposalsOf(candidate).some((entry) => entry.proposal.proposal_id === id)
    );
    if (!lock) throw new ScriptExitError(2, `task proposal ${id} not found in this case`);
    if (lock.superseded) {
      throw new ScriptExitError(
        2,
        `task proposal ${id} belongs to task ${lock.task_id}, which was superseded by ${lock.superseded.by_task_id}; nothing to re-ask`
      );
    }
    const entry = unresolvableTaskProposals(lock, agendas, ledger, now).find(
      (candidate) => candidate.proposal.proposal_id === id
    );
    if (entry) {
      pending.push({ lock, entry });
      continue;
    }
    const current = taskProposalsOf(lock).find(
      (candidate) => candidate.proposal.proposal_id === id
    );
    if (
      current?.proposal.previous_links?.length &&
      current.agenda_id &&
      !isClosed(byId.get(current.agenda_id))
    ) {
      already.push(id);
      continue;
    }
    throw new ScriptExitError(
      2,
      `task proposal ${id} is not unresolvable (it is pending, awaiting the customer on an open agenda, released, or not requires_customer); --reask only re-asks a question whose agenda was closed, withdrawn or lost with no confirmed answer`
    );
  }
  return { pending, already };
}

function collectLocked(
  opts: Record<string, string>,
  now: string,
  tenant: string,
  caseId: string,
  location: DecisionLedgerLocation,
  reask: ReaskRequest | undefined
): unknown {
  const target = opts.agenda ? loadAgenda(location, tenant, opts.agenda) : undefined;
  if (target && target.status !== 'draft') {
    throw new ScriptExitError(
      2,
      `agenda ${target.agenda_id} is ${target.status}; --from-tasks adds to a draft agenda only (omit --agenda to start a new one)`
    );
  }
  const candidates = reask ? reaskCandidates(location, reask, now) : undefined;
  const pending: PendingProposal[] = (
    candidates?.pending ??
    activeLocks(location).flatMap((lock) =>
      pendingTaskProposals(lock).map((entry) => ({ lock, entry }))
    )
  ).sort(
    (a, b) =>
      a.entry.proposal.proposed_at.localeCompare(b.entry.proposal.proposed_at) ||
      a.lock.consumer.localeCompare(b.lock.consumer)
  );
  if (pending.length === 0) {
    return {
      case_id: caseId,
      agenda_id: target?.agenda_id ?? null,
      collected: 0,
      added: 0,
      ...(candidates ? { reasked: 0, already_reasked: candidates.already } : {}),
    };
  }
  const agendaId = target?.agenda_id ?? newAgendaId();
  const others = new Map(
    openAgendas(listAgendas(location))
      .filter((agenda) => agenda.agenda_id !== agendaId)
      .map((agenda) => [agenda.agenda_id, agenda] as const)
  );
  const promotedAgendas = new Set<string>();
  const entries: AgendaEntry[] = [...(target?.entries ?? [])];
  const links = new Map<string, { agenda_id: string; entry_id: string }>();
  const conflicts: Array<{ proposal_id: string; agenda_id: string; entry_id: string }> = [];
  let added = 0;
  let linkedExisting = 0;
  let promoted = 0;
  let targetChanged = false;
  for (const { entry } of pending) {
    const pair = itemKey(entry);
    const requires = entry.proposal.requires_customer;
    const elsewhere = [...others.values()]
      .map((agenda) => ({
        agenda,
        asked: agenda.entries.find((candidate) => itemKey(candidate) === pair),
      }))
      .find((candidate) => candidate.asked);
    if (elsewhere?.asked) {
      const { agenda, asked } = elsewhere;
      if (requires && !asked.requires_customer) {
        // A requires_customer question never rides on an entry our decision
        // could settle: promote a draft entry, else leave it for the operator.
        if (agenda.status !== 'draft') {
          conflicts.push({
            proposal_id: entry.proposal.proposal_id,
            agenda_id: agenda.agenda_id,
            entry_id: asked.entry_id,
          });
          continue;
        }
        others.set(agenda.agenda_id, {
          ...agenda,
          entries: agenda.entries.map((candidate) =>
            candidate === asked ? requireCustomer(candidate) : candidate
          ),
        });
        promotedAgendas.add(agenda.agenda_id);
        promoted += 1;
      }
      links.set(entry.proposal.proposal_id, {
        agenda_id: agenda.agenda_id,
        entry_id: asked.entry_id,
      });
      linkedExisting += 1;
      continue;
    }
    const index = entries.findIndex((candidate) => itemKey(candidate) === pair);
    const here = index >= 0 ? entries[index] : undefined;
    if (!here) {
      entries.push(taskProposalAgendaEntry(entry));
      added += 1;
    } else if (requires && !here.requires_customer) {
      entries[index] = requireCustomer(here);
      targetChanged = true;
      promoted += 1;
    }
    links.set(entry.proposal.proposal_id, {
      agenda_id: agendaId,
      entry_id: here?.entry_id ?? entry.proposal.proposal_id,
    });
  }

  for (const id of promotedAgendas) {
    const agenda = others.get(id)!;
    assertUniqueEntries(agenda.entries);
    writeAgenda(location, { ...agenda, updated_at: now });
  }
  let written: DecisionAgenda | undefined = target;
  if (added > 0 || targetChanged) {
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
    if (reask) {
      relinkOnLock(tenant, location, lock, links, now, reask.by);
      continue;
    }
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
  audit(tenant, reask ? 'task_proposals_reask' : 'task_proposals_collect', {
    case_id: caseId,
    agenda_id: written?.agenda_id ?? null,
    proposal_ids: proposalIds,
    added,
    linked_existing: linkedExisting,
    promoted,
    conflicts: conflicts.length,
    consumers,
    ...(reask ? { reasked_by: reask.by, already_reasked: candidates?.already ?? [] } : {}),
    ...(written ? { content_hash: agendaContentHash(written) } : {}),
  });
  return {
    ...(written ? agendaSummary(written) : { case_id: caseId, agenda_id: null }),
    collected: links.size,
    added,
    linked_existing: linkedExisting,
    promoted,
    proposal_ids: proposalIds,
    ...(reask ? { reasked: links.size, already_reasked: candidates?.already ?? [] } : {}),
    ...(conflicts.length > 0
      ? {
          conflicts,
          conflict_note:
            'requires_customer questions on an item an approved or sent agenda asks without requires_customer: edit that agenda (draft --file) or withdraw it, then collect again',
        }
      : {}),
    ...(written && added > 0
      ? {
          next: `pnpm kyberion customer-decision submit --tenant ${tenant} --case ${caseId} --agenda ${written.agenda_id} --by user:<member>`,
        }
      : {}),
  };
}

/**
 * Write a re-asked lock as the content-checked consumer store role, owner
 * bound to the lock's consumer: the lock is read again under that capability
 * (the case lock is held), each listed proposal is relinked
 * (`relinkTaskProposal`) and the guard checks the write against the agendas
 * and the ledger on disk. Its hold is left as it is.
 */
function relinkOnLock(
  tenant: string,
  location: DecisionLedgerLocation,
  lock: ConsumedDecisionLockRecord,
  links: ReadonlyMap<string, { agenda_id: string; entry_id: string }>,
  now: string,
  by: string
): void {
  const own = `consumers/${lock.consumer}.json`;
  const relinked = taskProposalsOf(lock).filter((entry) => links.has(entry.proposal.proposal_id));
  const agendaFiles = [
    ...new Set(
      relinked.flatMap((entry) => [
        `agendas/${entry.agenda_id}.json`,
        `agendas/${links.get(entry.proposal.proposal_id)!.agenda_id}.json`,
      ])
    ),
  ];
  asCustomerDecisionConsumerOwner(
    tenant,
    location,
    { owner: lock.consumer, read: ['decisions.jsonl', ...agendaFiles, own], write: own },
    () => {
      const current = readConsumedDecisionLock(location, lock.consumer);
      if (!current) {
        throw new ScriptExitError(2, `consumer lock ${lock.consumer} disappeared; run again`);
      }
      writeConsumedDecisionLock(location, {
        ...current,
        decisions: current.decisions.map((decision) => {
          const link =
            decision.layer === 'task_proposal' && decision.proposal
              ? links.get(decision.proposal.proposal_id)
              : undefined;
          return link && decision.proposal
            ? relinkTaskProposal({ ...decision, proposal: decision.proposal }, link, now, by)
            : decision;
        }),
      });
    }
  );
}

/**
 * The task proposal part of `status`: pending proposals (not on an agenda
 * yet), tasks holding on a requires_customer question, each `awaiting`,
 * `resolved` (every held question has a confirmed customer decision; resume
 * the mission to re-run the task) or `unresolvable` (re-ask it or replace
 * the task), and superseded tasks (frozen, listed apart). Ids and counts;
 * call as the ledger writer.
 */
export function taskProposalStatus(
  tenant: string,
  caseId: string,
  location: DecisionLedgerLocation,
  now: string
): Record<string, unknown> {
  const all = readLocks(location);
  const superseded = all.filter((lock) => lock.superseded);
  const locks = all.filter((lock) => !lock.superseded);
  const pending = locks.flatMap((lock) =>
    pendingTaskProposals(lock).map((entry) => entry.proposal.proposal_id)
  );
  const held = locks.filter((lock) => lock.hold && lock.status === 'in_progress');
  const agendas = held.length > 0 ? listAgendas(location) : [];
  const ledger = held.length > 0 ? readLedger(location) : [];
  const holds = held.map((lock) => {
    const proposals = taskProposalHolds(lock, agendas, ledger, now);
    const resolved = proposals.length > 0 && proposals.every((hold) => hold.resolved_decision_id);
    // Its agenda is closed or withdrawn with no confirmed answer: nothing here releases it.
    const unresolvableIds = proposals
      .filter((hold) => hold.unresolvable)
      .map((hold) => hold.proposal_id);
    const unresolvable = !resolved && unresolvableIds.length > 0;
    return {
      consumer: lock.consumer,
      mission_id: lock.mission_id,
      task_id: lock.task_id,
      ...(lock.hold?.work_item_id ? { work_item_id: lock.hold.work_item_id } : {}),
      status: resolved ? 'resolved' : unresolvable ? 'unresolvable' : 'awaiting',
      proposal_ids: proposals.map((hold) => hold.proposal_id),
      uncollected: proposals.filter((hold) => !hold.collected).length,
      decision_ids: proposals.flatMap((hold) =>
        hold.resolved_decision_id ? [hold.resolved_decision_id] : []
      ),
      ...(resolved ? { next: `pnpm mission resume ${lock.mission_id}` } : {}),
      ...(unresolvable
        ? {
            unresolvable_proposal_ids: unresolvableIds,
            next: `ask again: pnpm kyberion customer-decision draft --tenant ${tenant} --case ${caseId} --from-tasks --reask ${unresolvableIds.join(',')} --customer <slug> --by user:<member>; or replace the task: pnpm mission supersede-task ${lock.mission_id} ${lock.task_id} --by <new_task_id> --reason <text> --request-approval`,
          }
        : {}),
    };
  });
  return {
    pending: { count: pending.length, proposal_ids: pending.sort() },
    awaiting_customer: holds,
    ...(superseded.length > 0
      ? {
          superseded: superseded.map((lock) => ({
            consumer: lock.consumer,
            mission_id: lock.mission_id,
            task_id: lock.task_id,
            by_task_id: lock.superseded!.by_task_id,
          })),
        }
      : {}),
    ...(pending.length > 0
      ? {
          next: `pnpm kyberion customer-decision draft --tenant ${tenant} --case ${caseId} --from-tasks --customer <slug>`,
        }
      : {}),
  };
}
