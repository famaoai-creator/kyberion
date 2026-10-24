/**
 * Operator verbs that build and send an agenda: draft, generate, submit, actor-add, send.
 * Part of scripts/customer_decision.ts (the entry point); see its header.
 */
import { humanActor } from '@agent/core/actor';
import { withExecutionContextAsync } from '@agent/core/authority';
import { getRegisteredEnvText, readJson } from '@agent/core/foundation';
import { auditChain } from '@agent/core/governance/audit-chain';
import { enforceApprovalGate } from '@agent/core/governance/approval-gate';
import { loadApprovalRequest } from '@agent/core/governance/approval-store';
import { installReasoningBackendsForService } from '@agent/core/reasoning/reasoning-bootstrap';
import { assertSafeRepositoryPath } from '@agent/core/secure-io';
import {
  CUSTOMER_ACTOR_ID_PATTERN,
  CUSTOMER_SLUG_PATTERN,
  appendDecisions,
  readCustomerActors,
  readLedger,
  writeCustomerActors,
  type DecisionAppendInput,
  type DecisionCustomerActor,
  type DecisionLedgerLocation,
  type DecisionRecord,
} from '@agent/core/decision-ledger';
import {
  agendaAnswerState,
  agendaContentHash,
  approvedOurDecisionIds,
  assertAgendaLinks,
  generateAgendaDraft,
  instantiateTemplate,
  issueInvite,
  loadDecisionTemplate,
  newAgendaId,
  withCustomerActorsLock,
  writeAgenda,
  type AgendaEntry,
  type DecisionAgenda,
} from '@agent/core/customer-decision';
import { ScriptExitError } from '../lib/harness.js';
import {
  LEDGER_ROLE,
  AGENDA_APPROVE_OPERATION,
  APPROVAL_CHANNEL,
  AUDIT_AGENT,
  DEFAULT_TEMPLATE,
  DEFAULT_ROOM_URL,
  usageError,
  requireOpt,
  tenantOf,
  locationOf,
  withCaseLock,
  asLedgerWriter,
  audit,
  memberActorId,
  loadAgenda,
  readRepoText,
  agendaSummary,
  editableEntry,
  assertUniqueEntries,
  assertNoOpenAgendaOverlap,
} from './common.js';
import { reconcileCase } from './reconcile.js';

// ---------------------------------------------------------------------------
// Operator verbs
// ---------------------------------------------------------------------------

export function runDraft(opts: Record<string, string>, now: string): unknown {
  const tenant = tenantOf(opts);
  const caseId = requireOpt(opts, 'case');
  const location = locationOf(opts, caseId);
  return withCaseLock(location, () => draftLocked(opts, now, tenant, caseId, location));
}

function draftLocked(
  opts: Record<string, string>,
  now: string,
  tenant: string,
  caseId: string,
  location: DecisionLedgerLocation
): unknown {
  if (opts.agenda) {
    const current = loadAgenda(location, tenant, opts.agenda);
    if (current.status === 'closed' || current.status === 'withdrawn') {
      throw new ScriptExitError(2, `agenda ${current.agenda_id} is ${current.status}`);
    }
    const incoming = readJson<Partial<DecisionAgenda>>(
      assertSafeRepositoryPath(requireOpt(opts, 'file'))
    );
    if (!incoming || typeof incoming !== 'object')
      throw new ScriptExitError(2, '--file must hold an agenda object');
    const entries = Array.isArray(incoming.entries)
      ? incoming.entries.map(editableEntry)
      : current.entries.map(editableEntry);
    assertUniqueEntries(entries);
    assertNoOpenAgendaOverlap(location, tenant, current.agenda_id, entries);
    const frozen = current.status === 'approved' || current.status === 'sent';
    const { approval: _approval, in_force: _inForce, ...rest } = current;
    void _approval;
    void _inForce;
    // The edit is not approved, but what was approved stays in force until it is.
    const inForce: DecisionAgenda['in_force'] =
      current.approval && current.approval.content_hash === agendaContentHash(current)
        ? {
            content_hash: current.approval.content_hash,
            approved_at: current.approval.approved_at,
            pinned_ids: [...approvedOurDecisionIds(current)],
          }
        : current.in_force;
    const { from: currentFrom, ...restWithoutFrom } = rest;
    const from = typeof incoming.from === 'string' ? incoming.from.trim() : currentFrom;
    const next: DecisionAgenda = {
      ...restWithoutFrom,
      ...(inForce ? { in_force: inForce } : {}),
      ...(from ? { from } : {}),
      title: typeof incoming.title === 'string' ? incoming.title : current.title,
      entries,
      revision: frozen ? current.revision + 1 : current.revision,
      status: 'draft',
      updated_at: now,
    };
    const written = asLedgerWriter(tenant, () => writeAgenda(location, next));
    audit(tenant, 'agenda_edit', {
      agenda_id: written.agenda_id,
      case_id: caseId,
      revision: written.revision,
      content_hash: agendaContentHash(written),
      new_revision: frozen,
    });
    return agendaSummary(written);
  }
  const customer = requireOpt(opts, 'customer');
  if (!CUSTOMER_SLUG_PATTERN.test(customer)) throw usageError('--customer must be a customer slug');
  // i18n-exempt: validates the --locale flag against the agenda schema's ja|en enum, not a UI branch
  const locale = opts.locale === 'en' ? 'en' : 'ja';
  const template = loadDecisionTemplate(opts.template ?? DEFAULT_TEMPLATE);
  const agenda = instantiateTemplate(template, {
    agendaId: newAgendaId(),
    tenantSlug: tenant,
    caseId,
    customer,
    locale,
    now,
    ...(opts.title ? { title: opts.title } : {}),
    ...(opts.from?.trim() ? { from: opts.from.trim() } : {}),
    ...(opts.deal ? { dealId: opts.deal } : {}),
    ...(opts.project ? { projectId: opts.project } : {}),
  });
  assertUniqueEntries(agenda.entries);
  assertNoOpenAgendaOverlap(location, tenant, agenda.agenda_id, agenda.entries);
  const written = asLedgerWriter(tenant, () => writeAgenda(location, agenda));
  audit(tenant, 'agenda_draft', {
    agenda_id: written.agenda_id,
    case_id: caseId,
    template: template.template_id,
    content_hash: agendaContentHash(written),
  });
  return agendaSummary(written);
}

export async function runGenerate(opts: Record<string, string>, now: string): Promise<unknown> {
  const tenant = tenantOf(opts);
  const caseId = requireOpt(opts, 'case');
  const location = locationOf(opts, caseId);
  const agenda = loadAgenda(location, tenant, requireOpt(opts, 'agenda'));
  if (agenda.status !== 'draft') {
    throw new ScriptExitError(
      2,
      `agenda ${agenda.agenda_id} is ${agenda.status}; generate only fills a draft`
    );
  }
  const intentText = readRepoText(requireOpt(opts, 'intent-file'), 'intent file');
  const groundingText = opts['grounding-file']
    ? readRepoText(opts['grounding-file'], 'grounding file')
    : undefined;
  installReasoningBackendsForService(AUDIT_AGENT);
  const result = await withExecutionContextAsync(
    LEDGER_ROLE,
    () =>
      generateAgendaDraft(agenda, {
        intentText,
        now,
        ...(groundingText ? { groundingText } : {}),
      }),
    undefined,
    tenant
  );
  const next: DecisionAgenda = { ...result.agenda, status: 'draft', updated_at: now };
  // The model call runs without the lock; the write only lands on the agenda it read.
  const written = withCaseLock(location, () => {
    const latest = loadAgenda(location, tenant, agenda.agenda_id);
    if (
      latest.status !== 'draft' ||
      latest.updated_at !== agenda.updated_at ||
      agendaContentHash(latest) !== agendaContentHash(agenda)
    ) {
      throw new ScriptExitError(
        2,
        `agenda ${agenda.agenda_id} changed while the draft was generated; run generate again`
      );
    }
    assertUniqueEntries(next.entries);
    return asLedgerWriter(tenant, () => writeAgenda(location, next));
  });
  audit(tenant, 'agenda_generate', {
    agenda_id: written.agenda_id,
    case_id: caseId,
    generated: result.generated,
    content_hash: agendaContentHash(written),
  });
  return { ...agendaSummary(written), generated: result.generated, notes: result.notes };
}

function activeRecord(
  ledger: readonly DecisionRecord[],
  entry: AgendaEntry
): DecisionRecord | undefined {
  for (let index = ledger.length - 1; index >= 0; index -= 1) {
    const record = ledger[index];
    if (record.status === 'active' && record.item === entry.item && record.key === entry.key) {
      return record;
    }
  }
  return undefined;
}

function isCustomerDecision(record: DecisionRecord | undefined): boolean {
  return Boolean(
    record &&
    record.level === 'customer-value' &&
    record.state === 'decided' &&
    record.decided_by?.on_behalf_of?.actor_id
  );
}

function approvalSummary(agenda: DecisionAgenda): string {
  const lines = agenda.entries.map((entry) => {
    const ours = entry.requires_customer
      ? 'requires the customer'
      : entry.our_decision
        ? `ours: ${JSON.stringify(entry.our_decision.value)}`
        : 'no decision of ours';
    return `- ${entry.entry_id} (${entry.kind}): ${entry.question} — ${ours}`;
  });
  return [
    `Agenda ${agenda.agenda_id} r${agenda.revision} for customer ${agenda.customer} (case ${agenda.case_id}): ${agenda.title}`,
    ...lines,
  ]
    .join('\n')
    .slice(0, 4000);
}

/**
 * Every entry must be answerable by the customer: an `approval` entry shows
 * the draft being approved (`our_decision.value`), a `ranking` entry ranks
 * its options. Refuses the agenda, listing the entries, before the gate.
 * A `requires_customer` approval is exempt: the schema forbids our decision
 * on it, so its question itself is what the customer approves (the answer
 * value is `{ approved: true }`).
 */
function assertAnswerable(agenda: DecisionAgenda): void {
  const problems: string[] = [];
  for (const entry of agenda.entries) {
    if (
      entry.kind === 'approval' &&
      !entry.requires_customer &&
      entry.our_decision?.value === undefined
    ) {
      problems.push(`${entry.entry_id} (approval: no draft in our_decision.value)`);
    }
    if (entry.kind === 'ranking' && (entry.options ?? []).length === 0) {
      problems.push(`${entry.entry_id} (ranking: no options)`);
    }
  }
  if (problems.length > 0) {
    throw new ScriptExitError(
      2,
      `agenda ${agenda.agenda_id} has entries the customer cannot answer: ${problems.join(', ')} — fill them (draft --file or generate) and submit again`
    );
  }
}

export function runSubmit(opts: Record<string, string>, now: string): unknown {
  const tenant = tenantOf(opts);
  const caseId = requireOpt(opts, 'case');
  const location = locationOf(opts, caseId);
  const member = memberActorId(opts.by);
  const role = opts.role === 'approver' ? 'approver' : 'owner';
  const agendaId = requireOpt(opts, 'agenda');
  return withCaseLock(location, () => {
    reconcileCase(tenant, location, now);
    return submitLocked(tenant, location, agendaId, member, role, now);
  });
}

function submitLocked(
  tenant: string,
  location: DecisionLedgerLocation,
  agendaId: string,
  member: string,
  role: 'owner' | 'approver',
  now: string
): unknown {
  const agenda = loadAgenda(location, tenant, agendaId);
  const hash = agendaContentHash(agenda);
  if (agenda.status === 'closed' || agenda.status === 'withdrawn') {
    throw new ScriptExitError(2, `agenda ${agenda.agenda_id} is ${agenda.status}`);
  }
  if (
    (agenda.status === 'approved' || agenda.status === 'sent') &&
    agenda.approval?.content_hash === hash
  ) {
    return { ...agendaSummary(agenda), already_approved: true };
  }
  assertUniqueEntries(agenda.entries);
  assertAnswerable(agenda);
  // Before the gate and the ledger pins: an internal link never gets approved.
  assertAgendaLinks(agenda);
  const correlationId = `${agenda.agenda_id}:${hash}`;
  const gate = enforceApprovalGate({
    requireApproval: true,
    intentId: AGENDA_APPROVE_OPERATION,
    operationId: AGENDA_APPROVE_OPERATION,
    agentId: AUDIT_AGENT,
    correlationId,
    channel: APPROVAL_CHANNEL,
    payload: { agenda_id: agenda.agenda_id, case_id: agenda.case_id, content_hash: hash },
    requestScope: { tenant_slug: tenant },
    draft: {
      title: `Approve customer decision agenda: ${agenda.title}`,
      summary: approvalSummary(agenda),
      severity: 'medium',
    },
  });
  if (!gate.allowed) {
    if (gate.status === 'pending' && agenda.status !== 'pending_approval') {
      asLedgerWriter(tenant, () =>
        writeAgenda(location, { ...agenda, status: 'pending_approval', updated_at: now })
      );
    }
    audit(tenant, 'agenda_submit', {
      agenda_id: agenda.agenda_id,
      content_hash: hash,
      request_id: gate.requestId,
      request_status: gate.requestStatus ?? gate.status,
      submitted_by: member,
      role,
    });
    const result = {
      ...agendaSummary({ ...agenda, status: 'pending_approval' }),
      approval_request_id: gate.requestId,
      request_status: gate.requestStatus ?? gate.status,
      message: gate.message,
      next: gate.requestId
        ? `pnpm kyberion approvals --approve ${gate.requestId}  then re-run this submit`
        : 'resolve the approval, then re-run this submit',
    };
    if (gate.requestStatus === 'rejected' || gate.requestStatus === 'effect_mismatch') {
      throw new ScriptExitError(1, '', true, result);
    }
    return result;
  }

  const decision = gate.requestId ? loadApprovalRequest(APPROVAL_CHANNEL, gate.requestId) : null;
  const approvedBy = decision?.decidedBy || member;
  const approvedAt = decision?.decidedAt || now;
  const proposer = humanActor(member.replace(/^user:/u, ''));

  return asLedgerWriter(tenant, () => {
    const ledger = readLedger(location);
    const records: DecisionAppendInput[] = [];
    const targets: string[] = [];
    const skipped: Array<{ entry_id: string; reason: string; decision_id?: string }> = [];
    for (const entry of agenda.entries) {
      if (!entry.our_decision || entry.requires_customer) continue;
      const active = activeRecord(ledger, entry);
      // Ours never supersedes a customer decision.
      if (isCustomerDecision(active)) {
        skipped.push({
          entry_id: entry.entry_id,
          reason: 'customer_decided',
          decision_id: active?.id,
        });
        continue;
      }
      records.push({
        item: entry.item,
        key: entry.key,
        level: 'customer-value',
        state: 'proposed',
        value: entry.our_decision.value,
        basis: [{ ref: `agenda:${agenda.agenda_id}`, version: hash }],
        origin: 'facade',
        proposed_by: proposer,
        proposed_at: now,
        ...(active ? { supersedes: active.id } : {}),
        ...(entry.our_decision.rationale
          ? { note: entry.our_decision.rationale.slice(0, 2000) }
          : {}),
      });
      targets.push(entry.entry_id);
    }
    const appended = records.length
      ? appendDecisions(location, records, { caseId: agenda.case_id }).appended
      : [];
    const pinned = new Map(targets.map((entryId, index) => [entryId, appended[index].id]));
    const entries = agenda.entries.map((entry): AgendaEntry => {
      if (!entry.our_decision) return entry;
      const { decision_id: _old, ...ours } = entry.our_decision;
      void _old;
      const id = pinned.get(entry.entry_id);
      return { ...entry, our_decision: id ? { ...ours, decision_id: id } : ours };
    });
    const approved: DecisionAgenda = {
      ...agenda,
      entries,
      status: 'approved',
      approval: {
        content_hash: hash,
        ...(gate.requestId ? { request_id: gate.requestId } : {}),
        approved_at: approvedAt,
        approved_by: approvedBy,
      },
      updated_at: now,
    };
    // Pinning ids must not move the hash, or the approval would pin nothing.
    const inForce = approvedOurDecisionIds(approved);
    for (const id of pinned.values()) {
      if (!inForce.has(id)) {
        throw new Error(`[CUSTOMER_DECISION_PIN_FAILED] pinned decision ${id} is not in force`);
      }
    }
    // Survives later edits (which drop `approval`) until the next approval.
    approved.in_force = { content_hash: hash, approved_at: approvedAt, pinned_ids: [...inForce] };
    const written = writeAgenda(location, approved);
    auditChain.record({
      agentId: AUDIT_AGENT,
      action: 'customer_decision',
      operation: 'agenda_approve',
      result: 'completed',
      tenantSlug: tenant,
      metadata: {
        agenda_id: agenda.agenda_id,
        case_id: agenda.case_id,
        revision: agenda.revision,
        content_hash: hash,
        request_id: gate.requestId,
        approved_by: approvedBy,
        submitted_by: member,
        role,
        decision_ids: [...pinned.values()],
        skipped,
      },
    });
    return {
      ...agendaSummary(written),
      approval_request_id: gate.requestId,
      approved_by: approvedBy,
      our_decisions: Object.fromEntries(pinned),
      skipped,
    };
  });
}

export function runActorAdd(opts: Record<string, string>): unknown {
  const tenant = tenantOf(opts);
  const caseId = requireOpt(opts, 'case');
  const location = locationOf(opts, caseId);
  const customer = requireOpt(opts, 'customer');
  if (!CUSTOMER_SLUG_PATTERN.test(customer)) throw usageError('--customer must be a customer slug');
  const actorId = requireOpt(opts, 'actor');
  if (!CUSTOMER_ACTOR_ID_PATTERN.test(actorId)) throw usageError('--actor must be customer:<id>');
  const name = requireOpt(opts, 'name');
  // The registry is shared by every case of the customer: serialize read → write.
  return withCustomerActorsLock(tenant, customer, () =>
    asLedgerWriter(tenant, () => {
      const actors = readCustomerActors(location, customer);
      const existing = actors.find((actor) => actor.id === actorId);
      const actor: DecisionCustomerActor = {
        ...(existing ?? {}),
        id: actorId,
        name,
        decides: [...new Set([...(existing?.decides ?? []), 'customer-value' as const])],
        ...(opts['confirm-target'] ? { confirm_target: opts['confirm-target'] } : {}),
      };
      const registry = writeCustomerActors(location, {
        version: '1.0.0',
        tenant_slug: tenant,
        customer,
        actors: [...actors.filter((item) => item.id !== actorId), actor],
      });
      auditChain.record({
        agentId: AUDIT_AGENT,
        action: 'customer_decision',
        operation: 'actor_add',
        result: 'completed',
        tenantSlug: tenant,
        metadata: {
          customer,
          actor_id: actorId,
          decides: actor.decides,
          updated: Boolean(existing),
        },
      });
      return { customer, actor, actors: registry.actors.length };
    })
  );
}

function assertSendable(agenda: DecisionAgenda): void {
  assertAgendaLinks(agenda);
  const state = agendaAnswerState(agenda);
  if (state.ok === false) {
    throw new ScriptExitError(
      2,
      `agenda ${agenda.agenda_id} is not approved in its current revision (${agenda.status}); run submit first`
    );
  }
}

export function runSend(opts: Record<string, string>, now: string): unknown {
  const tenant = tenantOf(opts);
  const caseId = requireOpt(opts, 'case');
  const location = locationOf(opts, caseId);
  const agendaId = requireOpt(opts, 'agenda');
  return withCaseLock(location, () => sendLocked(opts, now, tenant, location, agendaId));
}

function sendLocked(
  opts: Record<string, string>,
  now: string,
  tenant: string,
  location: DecisionLedgerLocation,
  agendaId: string
): unknown {
  const agenda = loadAgenda(location, tenant, agendaId);
  assertSendable(agenda);
  const participantRole = opts.role;
  if (participantRole !== 'decider' && participantRole !== 'contributor') {
    throw usageError('--role must be decider or contributor');
  }
  const actorId = requireOpt(opts, 'actor');
  const name = requireOpt(opts, 'name');
  const actors = asLedgerWriter(tenant, () => readCustomerActors(location, agenda.customer));
  const actor = actors.find((item) => item.id === actorId);
  if (!actor) {
    throw new ScriptExitError(
      2,
      `customer actor ${actorId} is not registered for ${agenda.customer}; run actor-add first`
    );
  }
  if (participantRole === 'decider' && !actor.decides.includes('customer-value')) {
    throw new ScriptExitError(2, `customer actor ${actorId} may not decide customer values`);
  }
  const ttlDays = opts['ttl-days'] ? Number(opts['ttl-days']) : 14;
  if (!Number.isFinite(ttlDays) || ttlDays <= 0)
    throw usageError('--ttl-days must be a positive number');
  const createdBy = opts.by ? memberActorId(opts.by) : 'operator:cli';
  // Invite I/O runs inside invite.ts as the tenant-bound invite store role.
  const { invite, token } = issueInvite({
    tenantSlug: tenant,
    caseId: agenda.case_id,
    agendaId: agenda.agenda_id,
    participant: { name, role: participantRole, actor_id: actorId },
    createdBy,
    now,
    ttlMs: ttlDays * 24 * 60 * 60 * 1000,
  });
  if (agenda.status !== 'sent') {
    asLedgerWriter(tenant, () =>
      writeAgenda(location, { ...agenda, status: 'sent', updated_at: now })
    );
  }
  audit(tenant, 'invite_issue', {
    agenda_id: agenda.agenda_id,
    case_id: agenda.case_id,
    invite_id: invite.invite_id,
    participant_role: participantRole,
    actor_id: actorId,
    expires_at: invite.expires_at,
    created_by: createdBy,
  });
  const base = (
    getRegisteredEnvText('KYBERION_CUSTOMER_ROOM_PUBLIC_URL') || DEFAULT_ROOM_URL
  ).replace(/\/+$/u, '');
  return {
    invite_id: invite.invite_id,
    agenda_id: agenda.agenda_id,
    participant: invite.participant,
    expires_at: invite.expires_at,
    /** Shown once. Not stored, logged or audited — copy it now. */
    link: `${base}/r#t=${token}`,
    delivery: 'manual',
    note: 'Forward this link to the participant yourself. Channel delivery (sendToCustomer) is not part of stage 1.',
  };
}
