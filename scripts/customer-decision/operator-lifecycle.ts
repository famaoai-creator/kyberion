/**
 * Operator verbs on a sent agenda: status, confirm, close / withdraw, revoke.
 * Part of scripts/customer_decision.ts (the entry point); see its header.
 */
import { auditChain } from '@agent/core/governance/audit-chain';
import { enforceApprovalGate } from '@agent/core/governance/approval-gate';
import { readLedger } from '@agent/core/decision-ledger';
import { sweepDecisionConsumers } from '@agent/core/mission/mission-decision-lock';
import {
  agendaContentHash,
  appendSwitches,
  detectSwitches,
  listInvites,
  listReceipts,
  listRespondJournals,
  newSwitchId,
  openChangeRequests,
  projectBriefInput,
  readSwitches,
  resolveAgendaEffective,
  revokeInvite,
  writeAgenda,
  writeBriefInput,
  type DecisionAgenda,
  type DecisionSwitch,
  type EffectiveDecision,
} from '@agent/core/customer-decision';
import { ScriptExitError } from '../lib/harness.js';
import {
  OPERATOR_CONFIRM_OPERATION,
  APPROVAL_CHANNEL,
  AUDIT_AGENT,
  requireOpt,
  tenantOf,
  locationOf,
  withCaseLock,
  asLedgerWriter,
  audit,
  memberActorId,
  loadAgenda,
  agendaSummary,
  inviteView,
  noteDealSwitches,
} from './common.js';
import { reconcileCase, unreconciledDecisions } from './reconcile.js';
import { taskProposalStatus } from './task-proposals.js';
import { boltReviewStatus, routeBoltReview } from './bolt-review.js';

function effectiveView(decision: EffectiveDecision): Record<string, unknown> {
  return {
    entry_id: decision.entry_id,
    item: decision.item,
    key: decision.key,
    layer: decision.layer,
    status: decision.status,
    ...(decision.value !== undefined ? { value: decision.value } : {}),
    ...(decision.decision_id ? { decision_id: decision.decision_id } : {}),
    overridable: decision.overridable,
    ...(decision.awaiting_operator_confirmation ? { awaiting_operator_confirmation: true } : {}),
  };
}

/**
 * `status --agenda <id>`: the agenda's decisions, invites, receipts and
 * switches, and for a bolt review (CD-10) where the answers went (routing is
 * retried first). Without `--agenda`, the case's task proposals only (CD-09). Both
 * forms carry `task_proposals` (pending proposals and held tasks).
 */
export function runStatus(opts: Record<string, string>, now: string): unknown {
  const tenant = tenantOf(opts);
  const caseId = requireOpt(opts, 'case');
  const location = locationOf(opts, caseId);
  const agendaId = opts.agenda?.trim();
  // CD-10: retry the routing of bolt-review answers a respond could not
  // finish — after completing interrupted responses, so their receipts count.
  let early: ReturnType<typeof reconcileCase> | undefined;
  if (agendaId) {
    early = withCaseLock(location, () => reconcileCase(tenant, location, now));
    routeBoltReview(tenant, location, agendaId, now);
  }
  return withCaseLock(location, () => {
    const reconciled = early ?? reconcileCase(tenant, location, now);
    if (!agendaId) {
      return {
        case_id: caseId,
        reconciled,
        task_proposals: asLedgerWriter(tenant, () =>
          taskProposalStatus(tenant, caseId, location, now)
        ),
      };
    }
    const agenda = loadAgenda(location, tenant, agendaId);
    const invites = listInvites(tenant, { agendaId: agenda.agenda_id, caseId: agenda.case_id });
    return asLedgerWriter(tenant, () => {
      const ledger = readLedger(location);
      const effective = resolveAgendaEffective(agenda, ledger, { now });
      const receipts = listReceipts(location, { agendaId: agenda.agenda_id });
      const pending = new Set(listRespondJournals(location).map((item) => item.receipt_id));
      const hash = agendaContentHash(agenda);
      return {
        ...agendaSummary(agenda),
        approval: agenda.approval ?? null,
        approval_current: agenda.approval?.content_hash === hash,
        in_force: agenda.in_force ?? null,
        effective: effective.map(effectiveView),
        awaiting_confirmation: effective
          .filter((decision) => decision.awaiting_operator_confirmation)
          .map((decision) => ({
            entry_id: decision.entry_id,
            decision_id: decision.decision_id,
            value: decision.value,
            decided_by: decision.decided_by,
            at: decision.at,
            next: `pnpm kyberion customer-decision confirm --tenant ${tenant} --case ${agenda.case_id} --agenda ${agenda.agenda_id} --entry ${decision.entry_id} --by user:<member>`,
          })),
        operator_confirmations: agenda.operator_confirmations ?? [],
        invites: invites.map(inviteView),
        receipts: receipts.map((receipt) => ({
          receipt_id: receipt.receipt_id,
          invite_id: receipt.invite_id,
          participant: receipt.participant,
          revision: receipt.agenda_revision,
          content_hash: receipt.content_hash,
          submitted_at: receipt.submitted_at,
          answers: receipt.answers,
          decision_ids: receipt.decision_ids,
          identity_assurance: receipt.identity_assurance,
        })),
        change_requests: openChangeRequests(agenda, receipts, effective),
        switches: readSwitches(location, { agendaId: agenda.agenda_id }),
        reconciled,
        unreconciled_decisions: unreconciledDecisions(
          agenda,
          ledger,
          new Set(receipts.map((receipt) => receipt.receipt_id)),
          pending
        ),
        task_proposals: taskProposalStatus(tenant, agenda.case_id, location, now),
        ...(agenda.bolt_mission_id ? { bolt_review: boltReviewStatus(agenda) } : {}),
      };
    });
  });
}

/**
 * CD-08 / 決定の層 row 1: confirm the customer's decision on a
 * `requires_customer` (money / contract) entry. Refused unless the entry's
 * effective decision is a customer decision; idempotent for the same
 * decision id (and re-adds the `confirmed` switch if a cut-off run lost it).
 *
 * A new confirmation goes through the approval gate (operation
 * `customer_decision:operator_confirm`, correlation
 * `<agenda>:<entry>:<decision_id>`), like `submit`: `--by` names who asks, the
 * gate decides. The gate runs under the caller's identity, outside the ledger
 * role, still holding the case lock, so nothing moves between the check and
 * the write.
 *
 * The confirmation is a customer-decision layer concept: it is recorded on the
 * agenda (`operator_confirmations`), never in the ledger. The ledger record
 * stays `state: decided` (it is the customer's decision), so a reader that
 * needs to know whether a money / contract decision is confirmed must use the
 * effective resolver (`resolveAgendaEffective`), not the ledger state alone.
 */
export function runConfirm(opts: Record<string, string>, now: string): unknown {
  const result = confirmDecision(opts, now);
  // CD-09: a confirmed requires_customer decision releases the tasks holding
  // on it (a `confirmed` switch never files rework). After the case lock (the
  // sweep takes it itself); best-effort, never fails the confirmation.
  const caseId = requireOpt(opts, 'case');
  sweepDecisionConsumers(
    {
      tenantSlug: tenantOf(opts),
      caseId,
      location: locationOf(opts, caseId),
      agendaId: requireOpt(opts, 'agenda'),
    },
    { now }
  );
  return result;
}

function confirmDecision(opts: Record<string, string>, now: string): unknown {
  const tenant = tenantOf(opts);
  const caseId = requireOpt(opts, 'case');
  const location = locationOf(opts, caseId);
  const agendaId = requireOpt(opts, 'agenda');
  const entryId = requireOpt(opts, 'entry');
  const member = memberActorId(opts.by);
  return withCaseLock(location, () => {
    reconcileCase(tenant, location, now);
    const target = asLedgerWriter(tenant, () => {
      const agenda = loadAgenda(location, tenant, agendaId);
      if (agenda.status === 'closed' || agenda.status === 'withdrawn') {
        throw new ScriptExitError(2, `agenda ${agenda.agenda_id} is ${agenda.status}`);
      }
      const entry = agenda.entries.find((item) => item.entry_id === entryId);
      if (!entry)
        throw new ScriptExitError(2, `agenda ${agenda.agenda_id} has no entry ${entryId}`);
      if (!entry.requires_customer) {
        throw new ScriptExitError(
          2,
          `entry ${entryId} is not requires_customer; its customer decision needs no operator confirmation`
        );
      }
      const ledger = readLedger(location);
      const before = resolveAgendaEffective(agenda, ledger, { now });
      const current = before.find((decision) => decision.entry_id === entryId) as EffectiveDecision;
      if (current.layer !== 'customer' || !current.decision_id) {
        throw new ScriptExitError(
          2,
          `entry ${entryId} has no customer decision to confirm (effective: ${current.layer} / ${current.status})`
        );
      }
      return { agenda, entry, ledger, before, current, decisionId: current.decision_id };
    });
    const { agenda, entry, decisionId } = target;
    let requestId: string | undefined;
    if (target.current.awaiting_operator_confirmation) {
      const gate = enforceApprovalGate({
        requireApproval: true,
        intentId: OPERATOR_CONFIRM_OPERATION,
        operationId: OPERATOR_CONFIRM_OPERATION,
        agentId: AUDIT_AGENT,
        correlationId: `${agenda.agenda_id}:${entryId}:${decisionId}`,
        channel: APPROVAL_CHANNEL,
        payload: {
          agenda_id: agenda.agenda_id,
          case_id: agenda.case_id,
          entry_id: entryId,
          decision_id: decisionId,
        },
        requestScope: { tenant_slug: tenant },
        draft: {
          title: `Confirm the customer's decision: ${entry.question}`.slice(0, 300),
          summary: [
            `Agenda ${agenda.agenda_id} r${agenda.revision} for customer ${agenda.customer} (case ${agenda.case_id})`,
            `- ${entryId} (${entry.kind}): ${entry.question}`,
            `- customer decision ${decisionId} by ${target.current.decided_by ?? 'unknown'}: ${JSON.stringify(target.current.value)}`,
            `- requested by ${member}`,
          ]
            .join('\n')
            .slice(0, 4000),
          severity: 'high',
        },
      });
      if (!gate.allowed) {
        audit(tenant, 'operator_confirm_request', {
          agenda_id: agenda.agenda_id,
          entry_id: entryId,
          decision_id: decisionId,
          request_id: gate.requestId,
          request_status: gate.requestStatus ?? gate.status,
          requested_by: member,
        });
        const result = {
          agenda_id: agenda.agenda_id,
          entry_id: entryId,
          decision_id: decisionId,
          status: target.current.status,
          approval_request_id: gate.requestId,
          request_status: gate.requestStatus ?? gate.status,
          message: gate.message,
          next: gate.requestId
            ? `pnpm kyberion approvals --approve ${gate.requestId}  then re-run this confirm`
            : 'resolve the approval, then re-run this confirm',
        };
        if (gate.requestStatus === 'rejected' || gate.requestStatus === 'effect_mismatch') {
          throw new ScriptExitError(1, '', true, result);
        }
        return result;
      }
      requestId = gate.requestId;
    }
    return asLedgerWriter(tenant, () => {
      const { ledger, before, current } = target;
      const decisionId = current.decision_id;
      const ctx = {
        case_id: agenda.case_id,
        agenda_id: agenda.agenda_id,
        now,
        newId: newSwitchId,
      };
      const alreadyConfirmed = !current.awaiting_operator_confirmation;
      let written = agenda;
      let after = before;
      let switches: DecisionSwitch[] = [];
      if (!alreadyConfirmed) {
        written = writeAgenda(location, {
          ...agenda,
          operator_confirmations: [
            ...(agenda.operator_confirmations ?? []),
            {
              entry_id: entryId,
              decision_id: decisionId,
              by: member,
              at: now,
              ...(requestId ? { request_id: requestId } : {}),
            },
          ],
          updated_at: now,
        });
        // Confirmations sit outside the content hash: the approval still holds.
        if (agendaContentHash(written) !== agendaContentHash(agenda)) {
          throw new Error('[CUSTOMER_DECISION_CONFIRM_HASH_MOVED] confirmation changed the hash');
        }
        after = resolveAgendaEffective(written, ledger, { now });
        switches = appendSwitches(
          location,
          detectSwitches(before, after, ctx).filter((item) => item.entry_id === entryId)
        );
      } else {
        const recorded = readSwitches(location, { agendaId: agenda.agenda_id }).some(
          (item) =>
            item.kind === 'confirmed' &&
            item.entry_id === entryId &&
            item.from.layer === 'customer' &&
            item.to.decision_id === decisionId
        );
        if (!recorded) {
          const provisional: EffectiveDecision = {
            ...current,
            status: 'provisional',
            awaiting_operator_confirmation: true,
          };
          switches = appendSwitches(location, detectSwitches([provisional], [current], ctx));
        }
      }
      writeBriefInput(location, projectBriefInput(written, after, now));
      auditChain.record({
        agentId: AUDIT_AGENT,
        action: 'customer_decision',
        operation: 'operator_confirm',
        result: 'completed',
        tenantSlug: tenant,
        metadata: {
          agenda_id: agenda.agenda_id,
          case_id: agenda.case_id,
          entry_id: entryId,
          decision_id: decisionId,
          confirmed_by: member,
          ...(requestId ? { request_id: requestId } : {}),
          already_confirmed: alreadyConfirmed,
          switch_ids: switches.map((item) => item.switch_id),
        },
      });
      const dealNoted = noteDealSwitches(tenant, written, switches);
      return {
        agenda_id: agenda.agenda_id,
        entry_id: entryId,
        decision_id: decisionId,
        confirmed_by: member,
        ...(requestId ? { approval_request_id: requestId } : {}),
        status: after.find((decision) => decision.entry_id === entryId)?.status,
        already_confirmed: alreadyConfirmed,
        switches: switches.length,
        deal_noted: dealNoted,
      };
    });
  });
}

export function runRevoke(opts: Record<string, string>, now: string): unknown {
  const tenant = tenantOf(opts);
  const caseId = requireOpt(opts, 'case');
  const inviteId = requireOpt(opts, 'invite');
  const reason = requireOpt(opts, 'reason');
  const invite = listInvites(tenant, { caseId }).find((item) => item.invite_id === inviteId);
  if (!invite) throw new ScriptExitError(2, `invite ${inviteId} not found for case ${caseId}`);
  const revoked = revokeInvite(tenant, inviteId, { now, reason });
  audit(tenant, 'invite_revoke', {
    invite_id: revoked.invite_id,
    agenda_id: revoked.agenda_id,
    case_id: revoked.case_id,
    reason,
  });
  return inviteView(revoked);
}

/**
 * End an agenda: `close` stops taking answers (its links answer `closed`);
 * `withdraw` also revokes every open invite of the agenda (its links answer
 * `revoked`). Both are terminal and end the item × key overlap block, so the
 * same decisions can be asked again in a new agenda. Under the case lock,
 * after the case's interrupted responses are completed, audited; re-running
 * with the same verb is a no-op, the other terminal verb is refused.
 */
export function runEnd(
  verb: 'close' | 'withdraw',
  opts: Record<string, string>,
  now: string
): unknown {
  const tenant = tenantOf(opts);
  const caseId = requireOpt(opts, 'case');
  const location = locationOf(opts, caseId);
  const agendaId = requireOpt(opts, 'agenda');
  const member = memberActorId(opts.by);
  const reason = opts.reason?.trim() || (verb === 'close' ? 'agenda closed' : 'agenda withdrawn');
  const status: DecisionAgenda['status'] = verb === 'close' ? 'closed' : 'withdrawn';
  return withCaseLock(location, () => {
    reconcileCase(tenant, location, now);
    const agenda = loadAgenda(location, tenant, agendaId);
    if (agenda.status === status) {
      return { ...agendaSummary(agenda), already: true, revoked_invites: [] };
    }
    if (agenda.status === 'closed' || agenda.status === 'withdrawn') {
      throw new ScriptExitError(2, `agenda ${agenda.agenda_id} is already ${agenda.status}`);
    }
    // Invite I/O runs inside invite.ts as the tenant-bound invite store role.
    const revoked =
      verb === 'withdraw'
        ? listInvites(tenant, { agendaId: agenda.agenda_id, caseId: agenda.case_id })
            .filter((invite) => !invite.revoked_at)
            .map((invite) => revokeInvite(tenant, invite.invite_id, { now, reason }).invite_id)
        : [];
    const written = asLedgerWriter(tenant, () =>
      writeAgenda(location, { ...agenda, status, updated_at: now })
    );
    audit(tenant, verb === 'close' ? 'agenda_close' : 'agenda_withdraw', {
      agenda_id: agenda.agenda_id,
      case_id: agenda.case_id,
      revision: agenda.revision,
      from_status: agenda.status,
      by: member,
      reason,
      revoked_invites: revoked,
    });
    return { ...agendaSummary(written), revoked_invites: revoked };
  });
}
