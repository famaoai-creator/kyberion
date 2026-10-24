/**
 * CD-11: customer reminders and operator hand-offs — `remind`, `reminders
 * --install`, the reminder / hand-off part of `status`, the hand-off
 * routing after `respond`, and the sweep the daily tenant pipeline op
 * (`core:customer_decision_reminders`) runs.
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
 * A `delivery_failed` attempt or a failed inbox write records nothing, so
 * the next sweep retries. Every agenda runs in its own try/catch: one
 * broken agenda never stops the others, and the sweep never throws for an
 * agenda. `--dry-run` writes nothing (no records, no inbox, no audit).
 *
 * Authority: the sweep is facade code — the case and actor reads/writes as
 * the tenant-bound `decision_ledger` role, invites through the invite store
 * role, the inbox as its shared core writer. It runs only in the facade
 * process: the operator's `customer-decision remind`, or the facade child the
 * daily op starts (`reminder-op.ts`, no SYSTEM_ROLE, bound to the run's
 * tenant — the customer room's rule). No role is widened.
 */
import { logger } from '@agent/core/core';
import { t } from '@agent/core/t';
import { withExecutionContextAsync } from '@agent/core/authority';
import {
  readLedger,
  readCustomerActors,
  type DecisionLedgerLocation,
} from '@agent/core/decision-ledger';
import {
  dueAgendaReminders,
  handoffTargets,
  isHandoffDone,
  listInvites,
  listReceipts,
  readAgenda,
  resolveAgendaEffective,
  upcomingAgendaReminders,
  withCustomerDecisionCaseLock,
  writeAgenda,
  type AgendaHandoffRecord,
  type AgendaReminderRecord,
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
import { promotePipelineAdf } from '../pipeline_promote.js';
import {
  LEDGER_ROLE,
  asLedgerWriter,
  audit,
  diagnosticCode,
  locationOf,
  tenantOf,
  usageError,
} from './common.js';

/** Surfaces whose outbox a bridge drains (`sendToCustomer`'s `deliver`). */
const OUTBOX_SURFACES = new Set(['slack', 'telegram', 'imessage', 'discord']);
type OutboxSurface = 'slack' | 'telegram' | 'imessage' | 'discord';

export const REMINDER_PIPELINE_TEMPLATE =
  'knowledge/product/pipeline-templates/customer-decision-reminders.json';
export const REMINDER_PIPELINE_NAME = 'customer-decision-reminders';

export type ReminderOutcome =
  | AgendaReminderRecord['status']
  | 'would_send'
  | 'would_remind_manually'
  | 'delivery_failed'
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
    approval_request_id?: string;
    inbox_entry_id?: string;
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
  const correlationId = `customer-decision-reminder:${tenant}:${reminder.reminder_id}`;
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
        template: reminder.template,
        correlationId,
        nonInteractive: true,
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
  const outcome: ReminderOutcome =
    result.status === 'sent'
      ? 'sent'
      : result.status === 'approval_pending'
        ? 'approval_pending'
        : result.status === 'denied'
          ? 'denied'
          : 'delivery_failed';
  return {
    outcome,
    ...(result.approvalRequestId ? { approval_request_id: result.approvalRequestId } : {}),
  };
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
      if (merged[index].status === 'approval_pending') merged[index] = record;
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
  result: ReminderSweepResult
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
  const due = dueAgendaReminders({
    agenda: state.agenda,
    invites: invites.filter((invite) => invite.agenda_id === agendaId),
    receipts: state.receipts,
    effective: state.effective,
    now,
  });
  if (due.length === 0) return;
  const records: AgendaReminderRecord[] = [];
  for (const reminder of due) {
    const base = {
      case_id: caseId,
      agenda_id: agendaId,
      reminder_id: reminder.reminder_id,
      kind: reminder.kind,
      actor_id: reminder.actor_id,
      target_date: reminder.target_date,
    };
    let outcome: ReminderOutcome = 'failed';
    let record: AgendaReminderRecord | undefined;
    try {
      const actor = state.actors.find((item) => item.id === reminder.actor_id);
      const channel = resolveChannel(tenant, actor);
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
        }
      }
    } catch (error) {
      outcome = 'failed';
      logger.warn(
        `customer decision reminder not sent — ${diagnosticCode(error)} | the next sweep retries it | reminder=${reminder.reminder_id} agenda=${agendaId}`
      );
    }
    if (record) records.push(record);
    result.reminders.push({
      ...base,
      outcome,
      ...(record?.approval_request_id ? { approval_request_id: record.approval_request_id } : {}),
      ...(record?.inbox_entry_id ? { inbox_entry_id: record.inbox_entry_id } : {}),
    });
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
        result
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
 * `reminders --install --tenant <t> [--force]`: promote the daily reminder
 * pipeline template into the tenant's pipeline catalog through
 * `pipeline:promote` (the governed tenant catalog write: `asset_promoter`
 * bound to the tenant, the tenant asset ledger, the catalog row). Chronos
 * runs it only after a human approves its project trust.
 */
export async function runRemindersInstall(
  opts: Record<string, string>,
  flags: ReadonlySet<string>
): Promise<unknown> {
  const tenant = tenantOf(opts);
  if (!flags.has('install')) {
    throw usageError('reminders needs --install (customer-decision remind sends them by hand)');
  }
  const result = await promotePipelineAdf([
    '--input',
    REMINDER_PIPELINE_TEMPLATE,
    '--tenant',
    tenant,
    '--name',
    REMINDER_PIPELINE_NAME,
    '--no-llm',
    ...(flags.has('force') ? ['--force'] : []),
    ...(flags.has('dry-run') ? ['--dry-run'] : []),
  ]);
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
    pending_approval: records.filter((record) => record.status === 'approval_pending'),
    manual: records.filter((record) => record.status === 'manual'),
    denied: records.filter((record) => record.status === 'denied'),
  };
}
