/**
 * Customer-room verbs (view / respond / attachment): STDIN in, customer-safe JSON out, reason codes only.
 * Part of scripts/customer_decision.ts (the entry point); see its header.
 */
import { logger } from '@agent/core/core';
import { auditChain } from '@agent/core/governance/audit-chain';
import {
  appendDecisions,
  readCustomerActors,
  readLedger,
  type DecisionLedgerLocation,
} from '@agent/core/decision-ledger';
import {
  ATTACHMENT_ID_PATTERN,
  agendaAnswerState,
  buildResponseReceipt,
  findDuplicateReceipt,
  listReceipts,
  newReceiptId,
  planCustomerResponse,
  readAgenda,
  readAgendaAttachment,
  resolveAgendaEffective,
  verifyInviteToken,
  writeRespondJournal,
  type CustomerDecisionInvite,
  type DecisionAgenda,
} from '@agent/core/customer-decision';
import { isActiveCustomerTenant } from '@agent/core/customer-channel-binding';
import { sweepDecisionConsumers } from '@agent/core/mission/mission-decision-lock';
import { ScriptExitError } from '../lib/harness.js';
import {
  AUDIT_AGENT,
  MAX_STDIN_BYTES,
  type CustomerDecisionIo,
  isTestRun,
  locationOf,
  withCaseLock,
  asLedgerWriter,
  diagnosticCode,
  auditFailure,
  noteDealSwitches,
  tenantOf,
} from './common.js';
import { completeRespond, reconcileCase } from './reconcile.js';
import { routeBoltReview } from './bolt-review.js';
import { routeHandoffs } from './reminders.js';

// ---------------------------------------------------------------------------
// Customer-room verbs: STDIN in, customer-safe JSON out, reason codes only
// ---------------------------------------------------------------------------

export type CustomerFacingFailure =
  | 'invalid_request'
  | 'invalid_link'
  | 'expired'
  | 'revoked'
  | 'updating'
  | 'closed'
  | 'stale_version'
  | 'invalid_answers'
  | 'not_entitled'
  | 'unavailable';

class CustomerFacingError extends Error {
  constructor(
    public readonly reason: CustomerFacingFailure,
    public readonly extra: Record<string, unknown> = {}
  ) {
    super(reason);
    this.name = 'CustomerFacingError';
  }
}

async function readProcessStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_STDIN_BYTES) throw new CustomerFacingError('invalid_request');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseStdinObject(raw: string): Record<string, unknown> {
  if (raw.length > MAX_STDIN_BYTES) throw new CustomerFacingError('invalid_request');
  try {
    const value = JSON.parse(raw) as unknown;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    /* fall through */
  }
  throw new CustomerFacingError('invalid_request');
}

/** Verify the token and load the agenda it opens. Every failure is a reason code. */
function openInvite(
  opts: Record<string, string>,
  token: unknown,
  action: 'view' | 'respond',
  now: string,
  record = true
): {
  tenant: string;
  invite: CustomerDecisionInvite;
  location: DecisionLedgerLocation;
  agenda: DecisionAgenda;
} {
  if (!opts.tenant || typeof token !== 'string') throw new CustomerFacingError('invalid_link');
  // The bound-tenant check before the token is verified (and recorded).
  const tenant = tenantOf(opts);
  // CD-10: invites of a tenant that is not registered and active stop working.
  // The customer sees the same `unavailable` as a store failure (never the
  // registration state); the audit trace carries ids only.
  if (!isActiveCustomerTenant(tenant)) {
    const inviteId = token.match(/^inv-[a-f0-9]{16}(?=\.)/u)?.[0];
    auditFailure(
      tenant,
      `invite_${action}`,
      'CD_INVITE_TENANT_NOT_REGISTERED',
      inviteId ? { invite_id: inviteId } : {}
    );
    throw new CustomerFacingError('unavailable');
  }
  const verified = verifyInviteToken(tenant, token, { now, action, record });
  if (verified.ok === false) {
    throw new CustomerFacingError(
      verified.reason === 'expired' ||
        verified.reason === 'revoked' ||
        verified.reason === 'unavailable'
        ? verified.reason
        : 'invalid_link'
    );
  }
  const invite = verified.invite;
  if (opts.case && opts.case !== invite.case_id) throw new CustomerFacingError('invalid_link');
  const location = locationOf(opts, invite.case_id);
  const agenda = asLedgerWriter(tenant, () => readAgenda(location, invite.agenda_id));
  if (!agenda) throw new CustomerFacingError('invalid_link');
  return { tenant, invite, location, agenda };
}

function receiptsForInvite(location: DecisionLedgerLocation, agendaId: string, inviteId: string) {
  return listReceipts(location, { agendaId }).filter((receipt) => receipt.invite_id === inviteId);
}

function runView(
  opts: Record<string, string>,
  input: Record<string, unknown>,
  now: string
): unknown {
  const { tenant, invite, location, agenda } = openInvite(opts, input.token, 'view', now);
  const state = agendaAnswerState(agenda);
  const participant = { name: invite.participant.name, role: invite.participant.role };
  if (state.ok === false) {
    return { ok: true, state: state.reason, participant };
  }
  return asLedgerWriter(tenant, () => {
    const effective = new Map(
      resolveAgendaEffective(agenda, readLedger(location), { now }).map((decision) => [
        decision.entry_id,
        decision,
      ])
    );
    return {
      ok: true,
      state: 'open',
      agenda: {
        title: agenda.title,
        ...(agenda.from ? { from: agenda.from } : {}),
        // CD-11: the date the customer is asked to answer by (UTC calendar date).
        ...(agenda.respond_by ? { respond_by: agenda.respond_by } : {}),
        locale: agenda.locale,
        revision: agenda.revision,
      },
      participant,
      content_hash: state.content_hash,
      entries: agenda.entries.map((entry) => {
        const current = effective.get(entry.entry_id);
        return {
          entry_id: entry.entry_id,
          kind: entry.kind,
          question: entry.question,
          ...(entry.background ? { background: entry.background } : {}),
          options: (entry.options ?? []).map((option) => ({
            label: option.label,
            value: option.value,
            ...(option.impact ? { impact: option.impact } : {}),
          })),
          // The draft an `approval` entry asks the customer to approve (submit refuses one without).
          ...(entry.kind === 'approval' && entry.our_decision?.value !== undefined
            ? { draft: entry.our_decision.value }
            : {}),
          // CD-10: images (fetched one by one through `attachment`) and external links.
          ...(entry.attachments?.length
            ? {
                attachments: entry.attachments.map((item) => ({
                  id: item.id,
                  name: item.name,
                  media_type: item.media_type,
                  bytes: item.bytes,
                })),
              }
            : {}),
          ...(entry.links?.length
            ? { links: entry.links.map((link) => ({ label: link.label, url: link.url })) }
            : {}),
          requires_customer: entry.requires_customer,
          current: {
            status: current?.status ?? 'undecided',
            layer: current?.layer ?? 'none',
            ...(current?.value !== undefined ? { value: current.value } : {}),
            awaiting_operator_confirmation: current?.awaiting_operator_confirmation === true,
          },
          overridable: current?.overridable ?? true,
        };
      }),
      receipts: receiptsForInvite(location, agenda.agenda_id, invite.invite_id).map((receipt) => ({
        receipt_id: receipt.receipt_id,
        submitted_at: receipt.submitted_at,
        revision: receipt.agenda_revision,
        answers: receipt.answers,
        ...(receipt.general_question ? { general_question: receipt.general_question } : {}),
      })),
    };
  });
}

function runRespond(
  opts: Record<string, string>,
  input: Record<string, unknown>,
  now: string
): unknown {
  const { tenant, invite, location } = openInvite(opts, input.token, 'respond', now);
  const result = withCaseLock(location, () => {
    reconcileCase(tenant, location, now);
    return asLedgerWriter(tenant, () => {
      // Re-read under the lock: everything below plans on the current state.
      const agenda = readAgenda(location, invite.agenda_id);
      if (!agenda) throw new CustomerFacingError('invalid_link');
      const ledger = readLedger(location);
      const receiptId = newReceiptId();
      const planned = planCustomerResponse({
        agenda,
        ledger,
        invite,
        content_hash: input.content_hash,
        answers: input.answers,
        general_question: input.general_question,
        customerActors: readCustomerActors(location, agenda.customer),
        receiptId,
        now,
      });
      if (planned.ok === false) {
        auditChain.record({
          agentId: AUDIT_AGENT,
          action: 'customer_decision',
          operation: 'respond',
          result: 'denied',
          reason: planned.reason,
          tenantSlug: tenant,
          metadata: { agenda_id: agenda.agenda_id, invite_id: invite.invite_id },
        });
        throw new CustomerFacingError(
          planned.reason,
          planned.errors ? { errors: planned.errors } : {}
        );
      }
      const plan = planned.plan;
      const duplicate = findDuplicateReceipt(
        plan,
        invite,
        receiptsForInvite(location, agenda.agenda_id, invite.invite_id)
      );
      if (duplicate) {
        return {
          ok: true,
          receipt_id: duplicate.receipt_id,
          switches: 0,
          change_requests: plan.change_requests.length,
          duplicate: true,
        };
      }

      // Write-ahead: the ids the ledger will assign (stable under the lock),
      // the receipt that cites them and the effective decisions before.
      const ids = plan.appends.length
        ? appendDecisions(location, plan.appends, {
            caseId: agenda.case_id,
            dryRun: true,
          }).appended.map((record) => record.id)
        : [];
      const journal = writeRespondJournal(location, {
        version: '1.0.0',
        receipt_id: receiptId,
        tenant_slug: agenda.tenant_slug,
        case_id: agenda.case_id,
        agenda_id: agenda.agenda_id,
        stage: 'planned',
        receipt: buildResponseReceipt(plan, agenda, invite, ids, now),
        before: plan.before,
        created_at: now,
        updated_at: now,
      });
      // 1. Ledger (all-or-nothing, ids as planned), then receipt → audit →
      //    switches → brief input (completeRespond), then the deal note.
      if (plan.appends.length) {
        appendDecisions(
          location,
          plan.appends.map((record, index) => ({ ...record, id: ids[index] })),
          { caseId: agenda.case_id }
        );
      }
      const done = completeRespond(tenant, location, agenda, journal, now, false);
      noteDealSwitches(tenant, agenda, done.appended);
      return {
        ok: true,
        receipt_id: done.receiptId,
        switches: done.switches.length,
        change_requests: plan.change_requests.length,
      };
    });
  });
  // CD-09: completed mission tasks that pinned a decision this agenda switched
  // get a rework WorkItem. After the case lock (the sweep takes it itself);
  // best-effort and idempotent over every recorded switch of the agenda, so a
  // failure never fails the customer's response and the next one retries it.
  // Its lock wait is short (SWEEP_LOCK_TIMEOUT_MS), so respond stays inside
  // the customer room's facade timeout even when the case is busy.
  sweepDecisionConsumers(
    { tenantSlug: tenant, caseId: invite.case_id, location, agendaId: invite.agenda_id },
    { now }
  );
  // CD-10: a bolt review's request_changes / reject goes to the backlog / the
  // operator. Same rules as the sweep: short lock wait, never fails the
  // response, retried by the next respond and by status.
  routeBoltReview(tenant, location, invite.agenda_id, now);
  // CD-11: answers outside the options, comments and a general question go
  // to the operator (ids and counts only). Same rules: short lock wait, never
  // fails the response, retried by the next respond and by status.
  routeHandoffs(tenant, location, invite.agenda_id, now);
  return result;
}

/**
 * `attachment` (CD-10): one image of the invite's agenda, only when the id is
 * listed on an entry of the approved revision the customer is shown. Any
 * other id — unknown, of another agenda or tenant, or an agenda being
 * updated — answers like an unknown link, so the verb is no oracle. Does not
 * record a use of the invite (the page fetches each image after `view`).
 */
function runAttachment(
  opts: Record<string, string>,
  input: Record<string, unknown>,
  now: string
): unknown {
  const attachmentId = input.attachment_id;
  if (typeof attachmentId !== 'string' || !ATTACHMENT_ID_PATTERN.test(attachmentId))
    throw new CustomerFacingError('invalid_link');
  const { tenant, location, agenda } = openInvite(opts, input.token, 'view', now, false);
  if (agendaAnswerState(agenda).ok === false) throw new CustomerFacingError('invalid_link');
  const attachment = agenda.entries
    .flatMap((entry) => entry.attachments ?? [])
    .find((item) => item.id === attachmentId);
  if (!attachment) throw new CustomerFacingError('invalid_link');
  const bytes = asLedgerWriter(tenant, () => readAgendaAttachment(location, attachment));
  if (!bytes) throw new CustomerFacingError('invalid_link');
  return { ok: true, media_type: attachment.media_type, bytes_base64: bytes.toString('base64') };
}

export async function runCustomerFacing(
  verb: 'view' | 'respond' | 'attachment',
  opts: Record<string, string>,
  io: CustomerDecisionIo,
  now: string
): Promise<unknown> {
  try {
    // A scratch case directory is a test seam; the room never gets one in production.
    if (opts.dir !== undefined && !isTestRun()) {
      throw new Error('[CUSTOMER_DECISION_DIR_REFUSED] --dir is only accepted in test runs');
    }
    const raw = io.stdin ?? (await readProcessStdin());
    const input = parseStdinObject(raw);
    if (verb === 'attachment') return runAttachment(opts, input, now);
    return verb === 'view' ? runView(opts, input, now) : runRespond(opts, input, now);
  } catch (error) {
    if (error instanceof CustomerFacingError) {
      throw new ScriptExitError(1, '', true, { ok: false, reason: error.reason, ...error.extra });
    }
    // `--json` silences the logger and the room drops stderr: leave an audit
    // trace with a reason code (never the token or the message), and hand the
    // code to the room, which logs it and never forwards it to the customer.
    const code = diagnosticCode(error);
    auditFailure(opts.tenant, verb, code);
    logger.warn(
      `customer-decision ${verb} failed — ${code} | check the agenda and stores | customer_decision ${verb}`
    );
    throw new ScriptExitError(1, '', true, {
      ok: false,
      reason: 'unavailable' as const,
      diagnostic_code: code,
    });
  }
}
