/**
 * CD-11: customer reminders and operator hand-offs — `remind`, `reminders
 * --install`, the reminder / hand-off part of `status`, the hand-off
 * routing after `respond`, and the sweep the tenant pipeline op
 * (`core:customer_decision_reminders`) runs — hourly from 09:30 to 18:30
 * Asia/Tokyo (`30 9-18 * * *`, every run on the same UTC date), so a held
 * reminder approved after one sweep goes out on the next one the same day.
 * Records keep each reminder to one send per day whatever the number of
 * sweeps. A tenant installed with the earlier daily schedule re-installs:
 * `reminders --install --force`, then a human re-approves the Chronos
 * project trust of the changed pipeline.
 * Part of scripts/customer_decision.ts (the entry point); see its header.
 *
 * Sweep (one tenant, every agenda it has sent invites for, or one case):
 *   1. plan (no lock): the reminders due today (UTC) and not settled yet
 *      (`dueAgendaReminders`);
 *   2. deliver, outside the case lock (the gate and the delivery are async):
 *      the decider's bound channel (`actor.channel`, re-checked against the
 *      tenant's channel bindings) → `sendToCustomer` with the fixed template
 *      and a stable correlation id, delivered as the surface outbox entry of
 *      that channel; no usable channel → an operator inbox task (ids only);
 *   3. record under the case lock (short wait): the outcome on the agenda's
 *      `reminders`, merged by reminder id, then an audit entry (ids only).
 * Held requests: a reminder's correlation id binds the surface, channel,
 * message and agenda content hash, so an approval covers exactly what is
 * sent. When a reminder gets an outcome, every other pending request of the
 * same reminder — on any outbox surface (the decider's channel moved), or for
 * an earlier text / agenda revision — is cancelled through the approval store
 * (a cancelled request cannot be decided, so approving it later sends
 * nothing) and listed on the record's `superseded_requests` with why. A held
 * reminder approved after its day's sweep goes out on the next sweep under
 * its original key (`REMINDER_CARRY_OVER_DAYS`, never after the date it is
 * about); one no longer due is recorded `lapsed`, its request withdrawn.
 * A `delivery_failed` attempt or a failed inbox write records nothing, so
 * the next sweep retries. Every agenda runs in its own try/catch: one
 * broken agenda never stops the others, and the sweep never throws for an
 * agenda. `--dry-run` writes nothing (no records, no inbox, no audit).
 *
 * Authority: the sweep is facade code — the case and actor reads/writes as
 * the tenant-bound `decision_ledger` role, invites through the invite store
 * role, the inbox as its shared core writer. It runs only in the facade
 * process: the operator's `customer-decision remind`, or the facade child the
 * scheduled op starts (`reminder-op.ts`, no SYSTEM_ROLE, bound to the run's
 * tenant — the customer room's rule). No role is widened.
 */
import { createHash } from 'node:crypto';
import { logger } from '@agent/core/core';
import { t } from '@agent/core/t';
import { withExecutionContext, withExecutionContextAsync } from '@agent/core/authority';
import {
  cancelApprovalRequest,
  listApprovalRequests,
  type ApprovalRequestRecord,
} from '@agent/core/governance/approval-store';
import {
  readLedger,
  readCustomerActors,
  type DecisionLedgerLocation,
} from '@agent/core/decision-ledger';
import {
  agendaContentHash,
  dueAgendaReminders,
  handoffTargets,
  isCoveredByEarlierReminder,
  isHandoffDone,
  lapsedAgendaReminders,
  listInvites,
  listReceipts,
  readAgenda,
  resolveAgendaEffective,
  upcomingAgendaReminders,
  withCustomerDecisionCaseLock,
  writeAgenda,
  type AgendaHandoffRecord,
  type AgendaReminderRecord,
  type AgendaReminderSupersededRequest,
  type AgendaReminderSupersedeReason,
  type CustomerDecisionInvite,
  type DecisionAgenda,
  type PlannedReminder,
} from '@agent/core/customer-decision';
import {
  notifyCustomerDecisionHandoff,
  notifyManualReminder,
} from '@agent/core/customer-decision/operator-handoff';
import { findTenantCustomerChannelBinding } from '@agent/core/customer-channel-binding';
import { sendToCustomer } from '@agent/core/customer-conversation';
import { renderCustomerRoutineTemplate } from '@agent/core/customer-outbound-templates';
import { enqueueSurfaceOutboxMessage } from '@agent/core/surface/surface-coordination-store';
import { SWEEP_LOCK_TIMEOUT_MS } from '@agent/core/mission/mission-decision-lock';
import { installRepositoryPipelineTemplate } from '../pipeline_promote.js';
import {
  LEDGER_ROLE,
  asLedgerWriter,
  audit,
  diagnosticCode,
  locationOf,
  memberActorId,
  tenantOf,
  usageError,
} from './common.js';

/** The approval store's shared writer (the role surfaces decide requests under). */
const APPROVAL_STORE_ROLE = 'surface_runtime';

/**
 * The role that may write a surface's approval channel (the same split as
 * surface-approval-ui.ts): only slack_bridge holds the slack channel grant.
 */
function approvalWriterRoleFor(surface: string): 'slack_bridge' | typeof APPROVAL_STORE_ROLE {
  return surface === 'slack' ? 'slack_bridge' : APPROVAL_STORE_ROLE;
}

/** Surfaces whose outbox a bridge drains (`sendToCustomer`'s `deliver`). */
const OUTBOX_SURFACES = new Set(['slack', 'telegram', 'imessage', 'discord']);
type OutboxSurface = 'slack' | 'telegram' | 'imessage' | 'discord';

export const REMINDER_PIPELINE_TEMPLATE =
  'knowledge/product/pipeline-templates/customer-decision-reminders.json';
export const REMINDER_PIPELINE_NAME = 'customer-decision-reminders';

/** The manual sweep of one case: sends a held reminder as soon as it is approved. */
function remindCommand(tenant: string, caseId: string): string {
  return `pnpm kyberion customer-decision remind --tenant ${tenant} --case ${caseId}`;
}

export type ReminderOutcome =
  | AgendaReminderRecord['status']
  | 'would_send'
  | 'would_remind_manually'
  | 'would_lapse'
  /** A `due` not sent: the decider got the carried-over `before_due` this run. */
  | 'covered'
  | 'delivery_failed'
  | 'unreachable'
  | 'failed';

export interface ReminderSweepResult {
  tenant: string;
  dry_run: boolean;
  now: string;
  agendas: number;
  /** Agendas skipped because they could not be read or recorded (diagnostic codes only). */
  agenda_failures: Array<{ case_id: string; agenda_id: string; diagnostic_code: string }>;
  reminders: Array<{
    case_id: string;
    agenda_id: string;
    reminder_id: string;
    kind: PlannedReminder['kind'];
    actor_id: string;
    target_date: string;
    outcome: ReminderOutcome;
    /** A held reminder sent (or asked again) after its send day. */
    carried_over?: true;
    approval_request_id?: string;
    inbox_entry_id?: string;
    /** Earlier pending requests of this reminder cancelled this run (ids only). */
    superseded_request_ids?: string[];
  }>;
  counts: Partial<Record<ReminderOutcome, number>>;
}

interface ChannelResolution {
  surface?: OutboxSurface;
  channelId?: string;
  manualReason?: NonNullable<AgendaReminderRecord['reason']>;
}

function resolveChannel(
  tenant: string,
  actor: { channel?: { surface: string; channel_id: string } } | undefined
): ChannelResolution {
  const channel = actor?.channel;
  if (!channel) return { manualReason: 'no_channel' };
  if (!findTenantCustomerChannelBinding(tenant, channel.surface, channel.channel_id))
    return { manualReason: 'binding_missing' };
  if (!OUTBOX_SURFACES.has(channel.surface)) return { manualReason: 'surface_unsupported' };
  return { surface: channel.surface as OutboxSurface, channelId: channel.channel_id };
}

/** The sent agendas of a tenant: the (case, agenda) pairs its invites name. */
function sentAgendaPairs(
  invites: readonly CustomerDecisionInvite[],
  caseId?: string
): Array<{ caseId: string; agendaId: string }> {
  const seen = new Map<string, { caseId: string; agendaId: string }>();
  for (const invite of invites) {
    if (caseId && invite.case_id !== caseId) continue;
    seen.set(`${invite.case_id}\u0000${invite.agenda_id}`, {
      caseId: invite.case_id,
      agendaId: invite.agenda_id,
    });
  }
  return [...seen.values()].sort(
    (a, b) => a.caseId.localeCompare(b.caseId) || a.agendaId.localeCompare(b.agendaId)
  );
}

async function deliverReminder(
  tenant: string,
  agenda: DecisionAgenda,
  reminder: PlannedReminder,
  channel: Required<Pick<ChannelResolution, 'surface' | 'channelId'>>
): Promise<{ outcome: ReminderOutcome; approval_request_id?: string }> {
  const binding = findTenantCustomerChannelBinding(tenant, channel.surface, channel.channelId);
  const body = renderCustomerRoutineTemplate(reminder.template);
  if (!binding || body === null) return { outcome: 'failed' };
  // Bound to the content: an approval (or a charter consumption) covers this
  // exact text to this exact channel for this agenda revision, never an
  // edited text, another channel or a changed agenda — also when the
  // approval comes after the day's sweep and the reminder is carried over.
  const correlationId = reminderCorrelationId(
    tenant,
    reminder,
    channel,
    body,
    agendaContentHash(agenda)
  );
  // Bound to the tenant (the facade's tenant-bound role), so the gate reads
  // the tenant's charter through its exact charter scope — the same binding
  // a chronos tenant run has from its environment.
  const result = await withExecutionContextAsync(
    LEDGER_ROLE,
    () =>
      sendToCustomer({
        binding,
        title: t('customer_decision:reminder_outbound_title', {
          reminderId: reminder.reminder_id,
          agendaId: agenda.agenda_id,
        }),
        body,
        // Ids only: the approval store is shared, so neither the agenda title
        // nor the message goes into the request; the approver reads it in the
        // tenant-scoped status. The request binds the body and channel by hash.
        approvalSummary: t('customer_decision:reminder_outbound_summary', {
          reminderId: reminder.reminder_id,
          kind: reminder.kind,
          date: reminder.target_date,
          templateId: reminder.template.id,
          agendaId: agenda.agenda_id,
          caseId: agenda.case_id,
          command: `pnpm kyberion customer-decision status --tenant ${tenant} --case ${agenda.case_id} --agenda ${agenda.agenda_id}`,
          next: remindCommand(tenant, agenda.case_id),
        }),
        template: reminder.template,
        correlationId,
        nonInteractive: true,
        // A scheduled sweep has no human present: open a durable request so a
        // human is actually asked (the decision lands on the next sweep or a
        // manual `remind`), scoped to the tenant so only its approvers see the
        // message the request summary carries.
        enqueueRequest: true,
        requestScope: { scope_kind: 'tenant', tier: 'confidential', tenant_slug: tenant },
        deliver: async (text) =>
          enqueueSurfaceOutboxMessage({
            surface: channel.surface,
            correlationId,
            channel: channel.channelId,
            threadTs: '',
            text,
            source: 'system',
            deduplicationKey: correlationId,
            scope: { scope_kind: 'tenant', tier: 'confidential', tenant_slug: tenant },
          }),
      }),
    undefined,
    tenant
  );
  // A rejected (or lapsed, or rebound) request is final: record it denied and
  // stop asking. `human_required` would mean no request was opened — not a
  // pending approval — so it is retried rather than recorded.
  const finalRefusal =
    result.approvalRequestStatus === 'rejected' ||
    result.approvalRequestStatus === 'expired' ||
    result.approvalRequestStatus === 'effect_mismatch';
  const outcome: ReminderOutcome =
    result.status === 'sent'
      ? 'sent'
      : result.status === 'denied' || finalRefusal
        ? 'denied'
        : result.status === 'approval_pending'
          ? result.approvalRequestId &&
            (result.approvalRequestStatus === 'created' ||
              result.approvalRequestStatus === 'pending')
            ? 'approval_pending'
            : // Held with no request a human can decide (a charter stop, no
              // request opened, or the correlation id names a request this
              // sweep withdrew earlier — the channel moved back): never
              // retried silently — a manual task.
              'unreachable'
          : 'delivery_failed';
  return {
    outcome,
    ...(result.approvalRequestId ? { approval_request_id: result.approvalRequestId } : {}),
  };
}

/** The correlation id prefix every request of one reminder shares, whatever its channel or text. */
export function reminderCorrelationPrefix(
  tenant: string,
  reminder: Pick<PlannedReminder, 'reminder_id'>
): string {
  return `customer-decision-reminder:${tenant}:${reminder.reminder_id}:`;
}

/** `customer-decision-reminder:<tenant>:<reminder>:<hash of channel + body + agenda content hash>`. */
export function reminderCorrelationId(
  tenant: string,
  reminder: Pick<PlannedReminder, 'reminder_id'>,
  channel: { surface: string; channelId: string },
  body: string,
  agendaHash: string
): string {
  const digest = createHash('sha256')
    .update([channel.surface, channel.channelId, body, agendaHash].join('\u0000'))
    .digest('hex')
    .slice(0, 16);
  return `${reminderCorrelationPrefix(tenant, reminder)}${digest}`;
}

/**
 * The pending reminder requests of one tenant sweep, listed once (lazily)
 * from the outbox surfaces' approval channels, tenant-scoped; `cancelled`
 * keeps one request from being withdrawn (or listed) twice.
 */
interface HeldRequestIndex {
  pending?: ApprovalRequestRecord[];
  cancelled: Set<string>;
}

function pendingReminderRequests(tenant: string, index: HeldRequestIndex): ApprovalRequestRecord[] {
  index.pending ??= withExecutionContext(APPROVAL_STORE_ROLE, () =>
    listApprovalRequests({
      storageChannels: [...OUTBOX_SURFACES],
      status: 'pending',
      scope: { scope_kind: 'tenant', tier: 'confidential', tenant_slug: tenant },
    })
  ).filter((record) =>
    String(record.correlationId ?? '').startsWith(`customer-decision-reminder:${tenant}:`)
  );
  return index.pending;
}

/**
 * Withdraw every other pending request of a reminder: on another surface
 * (the decider's channel moved), or for another channel id / text / agenda
 * revision on the same surface — or all of them when the reminder got no
 * request of its own (a manual task, lapsed). Cancelled through the approval
 * store, so the request cannot be approved afterwards and nothing is sent for
 * it. Best-effort: a request that cannot be cancelled is left (warned), never
 * fails the sweep.
 */
function withdrawHeldRequests(
  tenant: string,
  index: HeldRequestIndex,
  reminder: Pick<PlannedReminder, 'reminder_id'>,
  keep: { requestId?: string; surface?: string },
  otherReason: AgendaReminderSupersedeReason,
  now: string
): AgendaReminderSupersededRequest[] {
  const prefix = reminderCorrelationPrefix(tenant, reminder);
  let candidates: ApprovalRequestRecord[];
  try {
    candidates = pendingReminderRequests(tenant, index).filter(
      (record) =>
        String(record.correlationId).startsWith(prefix) &&
        record.id !== keep.requestId &&
        !index.cancelled.has(record.id)
    );
  } catch (error) {
    logger.warn(
      `customer decision reminder: earlier approval requests not checked — ${diagnosticCode(error)} | the next sweep checks again | reminder=${reminder.reminder_id}`
    );
    return [];
  }
  const withdrawn: AgendaReminderSupersededRequest[] = [];
  for (const record of candidates) {
    const surface = String(record.storageChannel || record.channel).toLowerCase();
    // Never cancel another tenant's request, whatever the listing returned.
    if (record.scope?.tenant_slug !== tenant) {
      logger.warn(
        `customer decision reminder: approval request outside the tenant skipped — scope_mismatch | nothing cancelled | request=${record.id} surface=${surface} reminder=${reminder.reminder_id}`
      );
      continue;
    }
    const reason: AgendaReminderSupersedeReason = keep.surface
      ? surface === keep.surface
        ? 'content_changed'
        : 'surface_changed'
      : otherReason;
    try {
      // The request is written under its channel's own role, as the surface
      // that created it (surface-approval-ui.ts): slack → slack_bridge.
      const writerRole = approvalWriterRoleFor(surface);
      const updated = withExecutionContext(writerRole, () =>
        cancelApprovalRequest(writerRole, {
          channel: record.channel,
          storageChannel: surface,
          requestId: record.id,
          cancelledBy: 'customer-decision',
          // Ids only: the approval store is shared.
          reason: `superseded: ${reason} (customer decision reminder ${reminder.reminder_id})`,
        })
      );
      index.cancelled.add(record.id);
      // Decided in the meantime: an approval of the old channel / text is
      // never presented again (the correlation id differs), so nothing sends.
      if (updated.status !== 'cancelled') continue;
      withdrawn.push({ request_id: record.id, surface, reason, at: now });
    } catch (error) {
      logger.warn(
        `customer decision reminder: earlier approval request not cancelled — ${diagnosticCode(error)} | cancel it by hand | request=${record.id} surface=${surface} reminder=${reminder.reminder_id}`
      );
    }
  }
  return withdrawn;
}

function mergeSuperseded(
  ...lists: Array<readonly AgendaReminderSupersededRequest[] | undefined>
): AgendaReminderSupersededRequest[] {
  const merged = new Map<string, AgendaReminderSupersededRequest>();
  for (const list of lists) for (const item of list ?? []) merged.set(item.request_id, item);
  return [...merged.values()];
}

function mergeReminders(
  current: readonly AgendaReminderRecord[],
  records: readonly AgendaReminderRecord[]
): AgendaReminderRecord[] {
  const merged = [...current];
  for (const record of records) {
    const index = merged.findIndex((item) => item.reminder_id === record.reminder_id);
    if (index >= 0) {
      // A final status is never overwritten by a later attempt.
      const previous = merged[index];
      if (previous.status === 'approval_pending' || previous.status === 'lapsed') {
        const superseded = mergeSuperseded(
          previous.superseded_requests,
          record.superseded_requests
        );
        const { superseded_requests: _drop, ...rest } = record;
        void _drop;
        merged[index] = superseded.length > 0 ? { ...rest, superseded_requests: superseded } : rest;
      }
    } else merged.push(record);
  }
  return merged;
}

/**
 * One agenda: plan, deliver, record. A throw (the case unreadable, the
 * record write refused) skips the agenda; anything already delivered keeps
 * its stable outbox deduplication key and gate correlation id, so a retry
 * does not queue it twice while the outbox entry is pending.
 */
async function sweepAgenda(
  tenant: string,
  location: DecisionLedgerLocation,
  caseId: string,
  agendaId: string,
  invites: readonly CustomerDecisionInvite[],
  dryRun: boolean,
  now: string,
  result: ReminderSweepResult,
  held: HeldRequestIndex
): Promise<void> {
  const state = asLedgerWriter(tenant, () => {
    const agenda = readAgenda(location, agendaId);
    if (!agenda) return null;
    return {
      agenda,
      receipts: listReceipts(location, { agendaId }),
      effective: resolveAgendaEffective(agenda, readLedger(location), { now }),
      actors: readCustomerActors(location, agenda.customer),
    };
  });
  if (!state) return;
  result.agendas += 1;
  const planInput = {
    agenda: state.agenda,
    invites: invites.filter((invite) => invite.agenda_id === agendaId),
    receipts: state.receipts,
    effective: state.effective,
    now,
  };
  // Carried-over reminders first, so a `before_due` sent today covers the
  // same decider's `due` in this run (stable: reminder id order otherwise).
  const due = [...dueAgendaReminders(planInput)].sort(
    (a, b) => Number(Boolean(b.carried_over)) - Number(Boolean(a.carried_over))
  );
  const lapsed = lapsedAgendaReminders(planInput);
  if (due.length === 0 && lapsed.length === 0) return;
  const heldRecords = new Map(
    (state.agenda.reminders ?? [])
      .filter((record) => record.status === 'approval_pending')
      .map((record) => [record.reminder_id, record])
  );
  const records: AgendaReminderRecord[] = [];
  const superseded = new Map<string, string[]>();
  /** Lapse a held record: withdraw its requests, record it `lapsed` (nothing sent). */
  const lapse = (
    record: AgendaReminderRecord,
    reason: AgendaReminderSupersedeReason
  ): ReminderOutcome => {
    if (dryRun) return 'would_lapse';
    const withdrawn = withdrawHeldRequests(tenant, held, record, {}, reason, now);
    if (withdrawn.length > 0)
      superseded.set(
        record.reminder_id,
        withdrawn.map((item) => item.request_id)
      );
    records.push({
      ...record,
      status: 'lapsed',
      at: now,
      ...(withdrawn.length > 0 ? { superseded_requests: withdrawn } : {}),
    });
    return 'lapsed';
  };
  for (const record of lapsed) {
    let outcome: ReminderOutcome = 'failed';
    try {
      outcome = lapse(
        record,
        isCoveredByEarlierReminder(record, state.agenda.reminders ?? [])
          ? 'covered_by_earlier_reminder'
          : 'no_longer_due'
      );
    } catch (error) {
      logger.warn(
        `customer decision reminder not lapsed — ${diagnosticCode(error)} | the next sweep retries it | reminder=${record.reminder_id} agenda=${agendaId}`
      );
    }
    const ids = superseded.get(record.reminder_id);
    result.reminders.push({
      case_id: caseId,
      agenda_id: agendaId,
      reminder_id: record.reminder_id,
      kind: record.kind,
      actor_id: record.actor_id,
      target_date: record.target_date,
      outcome,
      ...(record.approval_request_id ? { approval_request_id: record.approval_request_id } : {}),
      ...(ids ? { superseded_request_ids: ids } : {}),
    });
  }
  /** actor × target date whose `before_due` (carried over) or `due` went out this run. */
  const covered = new Set<string>();
  /** Carried-over `before_due` records left held this run, by actor × target date. */
  const heldCarried = new Map<string, AgendaReminderRecord>();
  for (const reminder of due) {
    const base = {
      case_id: caseId,
      agenda_id: agendaId,
      reminder_id: reminder.reminder_id,
      kind: reminder.kind,
      actor_id: reminder.actor_id,
      target_date: reminder.target_date,
      ...(reminder.carried_over ? { carried_over: true as const } : {}),
    };
    const coverKey = `${reminder.actor_id}\u0000${reminder.target_date}`;
    let outcome: ReminderOutcome = 'failed';
    let record: AgendaReminderRecord | undefined;
    try {
      if (reminder.kind !== 'override_closing' && covered.has(coverKey)) {
        // One message a day: that date's other reminder already went out.
        const earlier = heldRecords.get(reminder.reminder_id);
        outcome = earlier ? lapse(earlier, 'covered_by_earlier_reminder') : 'covered';
        const ids = superseded.get(reminder.reminder_id);
        result.reminders.push({
          ...base,
          outcome,
          ...(earlier?.approval_request_id
            ? { approval_request_id: earlier.approval_request_id }
            : {}),
          ...(ids ? { superseded_request_ids: ids } : {}),
        });
        continue;
      }
      const actor = state.actors.find((item) => item.id === reminder.actor_id);
      // A title the fixed template refuses (too long, a link, a mention, …)
      // cannot go out unattended: the operator reminds by hand.
      const channel: ChannelResolution =
        renderCustomerRoutineTemplate(reminder.template) === null
          ? { manualReason: 'template_refused' }
          : resolveChannel(tenant, actor);
      if (dryRun) {
        outcome = channel.manualReason ? 'would_remind_manually' : 'would_send';
        result.reminders.push({ ...base, outcome });
        continue;
      }
      const recordBase = {
        reminder_id: reminder.reminder_id,
        kind: reminder.kind,
        actor_id: reminder.actor_id,
        target_date: reminder.target_date,
        at: now,
      };
      if (channel.manualReason) {
        const notice = notifyManualReminder({
          tenantSlug: tenant,
          caseId,
          agendaId,
          reminder,
          reason: channel.manualReason,
        });
        outcome = 'manual';
        record = {
          ...recordBase,
          status: 'manual',
          reason: channel.manualReason,
          inbox_entry_id: notice.inbox_entry_id,
        };
      } else if (channel.surface && channel.channelId) {
        const delivered = await deliverReminder(tenant, state.agenda, reminder, {
          surface: channel.surface,
          channelId: channel.channelId,
        });
        outcome = delivered.outcome;
        if (outcome === 'sent' || outcome === 'approval_pending' || outcome === 'denied') {
          record = {
            ...recordBase,
            status: outcome,
            ...(delivered.approval_request_id
              ? { approval_request_id: delivered.approval_request_id }
              : {}),
          };
        } else if (outcome === 'unreachable') {
          const notice = notifyManualReminder({
            tenantSlug: tenant,
            caseId,
            agendaId,
            reminder,
            reason: 'approval_unreachable',
          });
          outcome = 'manual';
          record = {
            ...recordBase,
            status: 'manual',
            reason: 'approval_unreachable',
            inbox_entry_id: notice.inbox_entry_id,
          };
        }
        if (
          outcome === 'sent' &&
          (reminder.kind === 'due' || (reminder.kind === 'before_due' && reminder.carried_over))
        )
          covered.add(coverKey);
      }
      if (record) {
        // The reminder has its outcome now: withdraw its other pending
        // requests (another surface, an older channel / text / revision).
        const withdrawn = withdrawHeldRequests(
          tenant,
          held,
          reminder,
          channel.manualReason
            ? {}
            : { requestId: record.approval_request_id, surface: channel.surface },
          channel.manualReason === 'template_refused' ? 'content_changed' : 'channel_unusable',
          now
        );
        if (withdrawn.length > 0) {
          record = { ...record, superseded_requests: withdrawn };
          superseded.set(
            reminder.reminder_id,
            withdrawn.map((item) => item.request_id)
          );
        }
      }
    } catch (error) {
      outcome = 'failed';
      logger.warn(
        `customer decision reminder not sent — ${diagnosticCode(error)} | the next sweep retries it | reminder=${reminder.reminder_id} agenda=${agendaId}`
      );
    }
    if (record) records.push(record);
    if (record?.status === 'approval_pending' && reminder.carried_over)
      heldCarried.set(coverKey, record);
    const ids = superseded.get(reminder.reminder_id);
    result.reminders.push({
      ...base,
      outcome,
      ...(record?.approval_request_id ? { approval_request_id: record.approval_request_id } : {}),
      ...(record?.inbox_entry_id ? { inbox_entry_id: record.inbox_entry_id } : {}),
      ...(ids ? { superseded_request_ids: ids } : {}),
    });
  }
  // A carried-over `before_due` still held when the same decider's `due` went
  // out later in this run: covered — withdraw its request too, so approving
  // it afterwards sends nothing.
  for (const [key, record] of heldCarried) {
    if (!covered.has(key)) continue;
    const index = records.indexOf(record);
    const withdrawn = withdrawHeldRequests(
      tenant,
      held,
      record,
      {},
      'covered_by_earlier_reminder',
      now
    );
    const superseded_requests = mergeSuperseded(record.superseded_requests, withdrawn);
    records[index] = {
      ...record,
      status: 'lapsed',
      ...(superseded_requests.length > 0 ? { superseded_requests } : {}),
    };
    const item = result.reminders.find(
      (entry) => entry.agenda_id === agendaId && entry.reminder_id === record.reminder_id
    );
    if (item) {
      item.outcome = 'lapsed';
      if (superseded_requests.length > 0)
        item.superseded_request_ids = superseded_requests.map((entry) => entry.request_id);
    }
  }
  if (records.length === 0) return;
  withCustomerDecisionCaseLock(
    location,
    () => {
      const latest = asLedgerWriter(tenant, () => readAgenda(location, agendaId));
      if (!latest) return;
      asLedgerWriter(tenant, () =>
        writeAgenda(location, {
          ...latest,
          reminders: mergeReminders(latest.reminders ?? [], records),
          updated_at: now,
        })
      );
    },
    SWEEP_LOCK_TIMEOUT_MS
  );
  audit(tenant, 'reminder_sweep', {
    agenda_id: agendaId,
    case_id: caseId,
    reminders: records.map((record) => ({
      reminder_id: record.reminder_id,
      kind: record.kind,
      actor_id: record.actor_id,
      target_date: record.target_date,
      status: record.status,
      ...(record.approval_request_id ? { approval_request_id: record.approval_request_id } : {}),
      ...(record.inbox_entry_id ? { inbox_entry_id: record.inbox_entry_id } : {}),
      ...(record.superseded_requests
        ? {
            superseded_requests: record.superseded_requests.map((item) => ({
              request_id: item.request_id,
              surface: item.surface,
              reason: item.reason,
            })),
          }
        : {}),
    })),
  });
}

/**
 * Send the reminders due at `now` for one tenant (optionally one case).
 * Never throws for an agenda: failures are counted per agenda / reminder.
 */
export async function sweepTenantReminders(input: {
  tenant: string;
  caseId?: string;
  dryRun?: boolean;
  now: string;
  /** The case location (the facade's `--dir` test seam). */
  locationFor?: (caseId: string) => DecisionLedgerLocation;
}): Promise<ReminderSweepResult> {
  const tenant = input.tenant;
  const dryRun = input.dryRun === true;
  const result: ReminderSweepResult = {
    tenant,
    dry_run: dryRun,
    now: input.now,
    agendas: 0,
    agenda_failures: [],
    reminders: [],
    counts: {},
  };
  // Invite I/O runs inside invite.ts as the tenant-bound invite store role.
  const invites = listInvites(tenant, input.caseId ? { caseId: input.caseId } : {});
  const held: HeldRequestIndex = { cancelled: new Set() };
  for (const pair of sentAgendaPairs(invites, input.caseId)) {
    const location = input.locationFor
      ? input.locationFor(pair.caseId)
      : { tenantSlug: tenant, caseId: pair.caseId };
    try {
      await sweepAgenda(
        tenant,
        location,
        pair.caseId,
        pair.agendaId,
        invites,
        dryRun,
        input.now,
        result,
        held
      );
    } catch (error) {
      const code = diagnosticCode(error);
      result.agenda_failures.push({
        case_id: pair.caseId,
        agenda_id: pair.agendaId,
        diagnostic_code: code,
      });
      logger.warn(
        `customer decision reminder sweep skipped an agenda — ${code} | the other agendas went on; run customer-decision remind --tenant ${tenant} --case ${pair.caseId} to retry | agenda=${pair.agendaId}`
      );
    }
  }
  for (const item of result.reminders) {
    result.counts[item.outcome] = (result.counts[item.outcome] ?? 0) + 1;
  }
  return result;
}

/** `remind --tenant <t> [--case <id>] [--dry-run] [--now <iso>]` */
export async function runRemind(
  opts: Record<string, string>,
  flags: ReadonlySet<string>,
  now: string
): Promise<unknown> {
  const tenant = tenantOf(opts);
  const at = opts.now?.trim() || now;
  if (!Number.isFinite(Date.parse(at))) throw usageError('--now must be an ISO timestamp');
  const caseId = opts.case?.trim();
  return sweepTenantReminders({
    tenant,
    ...(caseId ? { caseId } : {}),
    dryRun: flags.has('dry-run'),
    now: new Date(Date.parse(at)).toISOString(),
    locationFor: (id) => locationOf(opts, id),
  });
}

/**
 * `reminders --install --tenant <t> --by user:<member> [--force]`: promote the hourly reminder
 * pipeline template into the tenant's pipeline catalog through
 * `pipeline:promote` (the governed tenant catalog write: `asset_promoter`
 * bound to the tenant, the tenant asset ledger, the catalog row). Chronos
 * runs it only after a human approves its project trust. `--by` names the
 * operator for the tenant asset ledger (`ingested_by`): a tenant asset is
 * never landed anonymously, and the operator CLI needs no identity env.
 */
export async function runRemindersInstall(
  opts: Record<string, string>,
  flags: ReadonlySet<string>
): Promise<unknown> {
  const tenant = tenantOf(opts);
  if (!flags.has('install')) {
    throw usageError('reminders needs --install (customer-decision remind sends them by hand)');
  }
  const by = memberActorId(opts.by);
  const result = await installRepositoryPipelineTemplate(
    [
      '--input',
      REMINDER_PIPELINE_TEMPLATE,
      '--tenant',
      tenant,
      '--name',
      REMINDER_PIPELINE_NAME,
      '--no-llm',
      ...(flags.has('force') ? ['--force'] : []),
      ...(flags.has('dry-run') ? ['--dry-run'] : []),
    ],
    { ingestedBy: by }
  );
  return {
    tenant,
    installed: result.target,
    dry_run: result.dry_run,
    next_steps: result.next_steps,
  };
}

// ---------------------------------------------------------------------------
// Hand-offs (after respond, retried by status)
// ---------------------------------------------------------------------------

export interface HandoffRoutingSummary {
  routed: number;
  /** Receipts not handed off this time (the next respond / status retries). */
  pending: number;
}

/**
 * Hand the operator the receipts of one agenda with answers outside the
 * options, comments or a general question (inbox entry + notification, ids
 * and counts only), recorded on the agenda's `handoffs`. Idempotent; waits
 * briefly for the case lock and never throws — the customer's response is
 * already recorded.
 */
export function routeHandoffs(
  tenant: string,
  location: DecisionLedgerLocation,
  agendaId: string,
  now: string
): HandoffRoutingSummary {
  const summary: HandoffRoutingSummary = { routed: 0, pending: 0 };
  try {
    withCustomerDecisionCaseLock(
      location,
      () => {
        const agenda = asLedgerWriter(tenant, () => readAgenda(location, agendaId));
        if (!agenda) return;
        const receipts = asLedgerWriter(tenant, () => listReceipts(location, { agendaId }));
        const records: AgendaHandoffRecord[] = [...(agenda.handoffs ?? [])];
        const targets = handoffTargets(agenda, receipts).filter(
          (target) => !isHandoffDone(target, records)
        );
        if (targets.length === 0) return;
        for (const target of targets) {
          try {
            const notice = notifyCustomerDecisionHandoff({
              tenantSlug: tenant,
              caseId: agenda.case_id,
              agendaId,
              target,
            });
            // A retryable push is not a notification yet: keep the inbox
            // entry, leave `notified_at` unset, retry on the next respond / status.
            const done = notice.push_status !== 'retryable';
            const record: AgendaHandoffRecord = {
              ...target,
              inbox_entry_id: notice.inbox_entry_id,
              ...(done ? { notified_at: now } : {}),
              at: now,
            };
            const index = records.findIndex((item) => item.receipt_id === target.receipt_id);
            if (index >= 0) records[index] = record;
            else records.push(record);
            summary.routed += 1;
            if (!done) summary.pending += 1;
          } catch (error) {
            summary.pending += 1;
            logger.warn(
              `customer decision hand-off skipped — ${diagnosticCode(error)} | the customer's answer is recorded; run customer-decision status --agenda ${agendaId} to retry | receipt=${target.receipt_id}`
            );
          }
        }
        if (summary.routed === 0) return;
        asLedgerWriter(tenant, () =>
          writeAgenda(location, { ...agenda, handoffs: records, updated_at: now })
        );
        audit(tenant, 'handoff_route', {
          agenda_id: agendaId,
          case_id: agenda.case_id,
          handoffs: records.map((record) => ({
            receipt_id: record.receipt_id,
            off_option: record.off_option,
            comments: record.comments,
            general_question: record.general_question,
            inbox_entry_id: record.inbox_entry_id,
            notified: Boolean(record.notified_at),
          })),
        });
      },
      SWEEP_LOCK_TIMEOUT_MS
    );
  } catch (error) {
    summary.pending += 1;
    logger.warn(
      `customer decision hand-off skipped — ${diagnosticCode(error)} | the customer's answer is recorded; run customer-decision status --agenda ${agendaId} to retry | agenda=${agendaId}`
    );
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/** The reminder / hand-off part of `status --agenda` (ids, dates, counts). */
export function reminderStatus(
  agenda: DecisionAgenda,
  invites: readonly CustomerDecisionInvite[],
  receipts: Parameters<typeof upcomingAgendaReminders>[0]['receipts'],
  effective: Parameters<typeof upcomingAgendaReminders>[0]['effective'],
  now: string
): Record<string, unknown> {
  const input = { agenda, invites, receipts, effective, now };
  const records = agenda.reminders ?? [];
  return {
    respond_by: agenda.respond_by ?? null,
    due_now: dueAgendaReminders(input).map((item) => ({
      reminder_id: item.reminder_id,
      kind: item.kind,
      actor_id: item.actor_id,
      target_date: item.target_date,
    })),
    next: upcomingAgendaReminders(input).map((item) => ({
      reminder_id: item.reminder_id,
      kind: item.kind,
      actor_id: item.actor_id,
      target_date: item.target_date,
      send_on: item.send_on,
    })),
    sent: records.filter((record) => record.status === 'sent'),
    // A held reminder goes out on the next hourly sweep once approved, or now by hand.
    pending_approval: records
      .filter((record) => record.status === 'approval_pending')
      .map((record) => ({ ...record, next: remindCommand(agenda.tenant_slug, agenda.case_id) })),
    manual: records.filter((record) => record.status === 'manual'),
    denied: records.filter((record) => record.status === 'denied'),
    lapsed: records.filter((record) => record.status === 'lapsed'),
  };
}
