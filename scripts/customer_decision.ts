/**
 * customer_decision.ts — the governed facade of customer decision hearing
 * (CD-05 / CD-06 / CD-08, plan
 * docs/developer/improvement-plans-2026-10/CUSTOMER_DECISION_HEARING_PLAN_2026-10-24.ja.md).
 *
 * The only writer of agendas, receipts, switches, invites and the customer
 * decisions they put in the SSOD ledger. The customer-room display runs the
 * built script (`dist/scripts/customer_decision.js`) as a child process for
 * `view` / `respond` and never touches the stores itself.
 *
 * Operator verbs (all take --tenant <slug> --case <id>; --json for machine output):
 *   draft    --customer <slug> [--template aidlc-inception] [--title <t>] [--locale ja|en] [--deal <id>] [--project <id>]
 *   draft    --agenda <id> --file <agenda.json>        replace title/entries (an approved/sent agenda becomes a new revision)
 *   generate --agenda <id> --intent-file <path> [--grounding-file <path>]
 *   submit   --agenda <id> --by user:<member> [--role owner|approver]
 *   actor-add --customer <slug> --actor customer:<id> --name <text> [--confirm-target <text>]
 *   send     --agenda <id> --name <participant> --role decider|contributor --actor customer:<id> [--ttl-days 14] [--by user:<member>]
 *   status   --agenda <id>
 *   revoke   --invite <id> --reason <text>
 *
 * Customer-room verbs (token on STDIN only, never argv; --case is optional and
 * must match the invite when given):
 *   view     --tenant <slug>    stdin {"token"}
 *   respond  --tenant <slug>    stdin {"token","content_hash","answers":[...]}
 *
 * `send` prints the invite link once on stdout; the token is never written to
 * disk, logs or the audit chain. Delivering the link through a bound customer
 * channel (`sendToCustomer`) needs a bridge-supplied `deliver` and is not part
 * of stage 1 — the operator forwards the link.
 *
 * `--dir <path>` (tests only) replaces the case directory; invites still live
 * in the tenant's runtime partition.
 */
import { humanActor } from '@agent/core/actor';
import { withExecutionContext, withExecutionContextAsync } from '@agent/core/authority';
import { getRegisteredEnvText, nowIso, readJson } from '@agent/core/foundation';
import { logger } from '@agent/core/core';
import { auditChain } from '@agent/core/governance/audit-chain';
import { enforceApprovalGate } from '@agent/core/governance/approval-gate';
import { loadApprovalRequest } from '@agent/core/governance/approval-store';
import { installReasoningBackendsForService } from '@agent/core/reasoning/reasoning-bootstrap';
import { assertSafeRepositoryPath, safeExistsSync, safeReadFile } from '@agent/core/secure-io';
import { appendDealNote, getDeal } from '@agent/core/deal-store';
import {
  CUSTOMER_ACTOR_ID_PATTERN,
  CUSTOMER_SLUG_PATTERN,
  DECISION_LEDGER_ROLES,
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
  appendSwitches,
  approvedOurDecisionIds,
  buildResponseReceipt,
  dealNoteForSwitches,
  detectSwitches,
  findDuplicateReceipt,
  generateAgendaDraft,
  instantiateTemplate,
  issueInvite,
  listInvites,
  listReceipts,
  loadDecisionTemplate,
  newAgendaId,
  newReceiptId,
  newSwitchId,
  openChangeRequests,
  planCustomerResponse,
  projectBriefInput,
  readAgenda,
  readSwitches,
  resolveAgendaEffective,
  revokeInvite,
  verifyInviteToken,
  writeAgenda,
  writeBriefInput,
  writeReceipt,
  type AgendaEntry,
  type CustomerDecisionInvite,
  type DecisionAgenda,
} from '@agent/core/customer-decision';
import {
  currentProcessArgv,
  defineScript,
  isDirectScript,
  ScriptExitError,
} from './lib/harness.js';

/** Agendas, receipts, switches, brief input, ledger and customer actors (tenant-bound). */
const LEDGER_ROLE = DECISION_LEDGER_ROLES.write;
/** Deal notes under `customer/<tenant>/deals/` (same role as the operator's deal documents). */
const DEAL_WRITE_ROLE = 'mission_controller';

export const AGENDA_APPROVE_OPERATION = 'customer_decision:agenda_approve';
const APPROVAL_CHANNEL = 'terminal';
const AUDIT_AGENT = 'customer-decision';
const DEFAULT_TEMPLATE = 'aidlc-inception';
const DEFAULT_ROOM_URL = 'http://127.0.0.1:3046';
const MAX_STDIN_BYTES = 256 * 1024;

interface ParsedArgs {
  verb: string;
  opts: Record<string, string>;
  flags: Set<string>;
}

export interface CustomerDecisionIo {
  /** STDIN text for `view` / `respond` (tests); defaults to reading process.stdin. */
  stdin?: string;
  /** Clock override (tests). */
  now?: () => string;
}

export function parseCustomerDecisionArgs(argv: readonly string[]): ParsedArgs {
  const [verb = 'help', ...rest] = argv;
  const opts: Record<string, string> = {};
  const flags = new Set<string>();
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg.startsWith('--')) continue;
    const name = arg.slice(2);
    const next = rest[index + 1];
    if (next === undefined || next.startsWith('--')) {
      flags.add(name);
    } else {
      opts[name] = next;
      index += 1;
    }
  }
  return { verb, opts, flags };
}

function usage(): string {
  return [
    'pnpm kyberion customer-decision draft     --tenant <slug> --case <id> --customer <slug> [--template aidlc-inception] [--title <t>] [--locale ja|en] [--deal <id>] [--project <id>]',
    'pnpm kyberion customer-decision draft     --tenant <slug> --case <id> --agenda <id> --file <agenda.json>',
    'pnpm kyberion customer-decision generate  --tenant <slug> --case <id> --agenda <id> --intent-file <path> [--grounding-file <path>]',
    'pnpm kyberion customer-decision submit    --tenant <slug> --case <id> --agenda <id> --by user:<member> [--role owner|approver]',
    'pnpm kyberion customer-decision actor-add --tenant <slug> --case <id> --customer <slug> --actor customer:<id> --name <text> [--confirm-target <text>]',
    'pnpm kyberion customer-decision send      --tenant <slug> --case <id> --agenda <id> --name <participant> --role decider|contributor --actor customer:<id> [--ttl-days 14] [--by user:<member>]',
    'pnpm kyberion customer-decision status    --tenant <slug> --case <id> --agenda <id>',
    'pnpm kyberion customer-decision revoke    --tenant <slug> --case <id> --invite <id> --reason <text>',
    'pnpm kyberion customer-decision view      --tenant <slug> [--case <id>] --json   (stdin: {"token"})',
    'pnpm kyberion customer-decision respond   --tenant <slug> [--case <id>] --json   (stdin: {"token","content_hash","answers"})',
    '',
    'send prints the invite link once; forward it to the customer yourself.',
    'Delivery through a bound customer channel (sendToCustomer) is not part of stage 1.',
  ].join('\n');
}

function usageError(message: string): ScriptExitError {
  return new ScriptExitError(2, `${message}\n${usage()}`);
}

function requireOpt(opts: Record<string, string>, name: string): string {
  const value = opts[name];
  if (!value || !value.trim()) throw usageError(`--${name} is required`);
  return value.trim();
}

function tenantOf(opts: Record<string, string>): string {
  return requireOpt(opts, 'tenant');
}

function locationOf(opts: Record<string, string>, caseId: string): DecisionLedgerLocation {
  if (opts.dir) return { dir: opts.dir };
  return { tenantSlug: tenantOf(opts), caseId };
}

function asLedgerWriter<T>(tenant: string, fn: () => T): T {
  return withExecutionContext(LEDGER_ROLE, fn, undefined, tenant);
}

/**
 * Invite records (`active/shared/runtime/customer-decision-invites/confidential/<tenant>/`).
 * The tier guard checks a tier-partitioned runtime record as its knowledge
 * mirror (`knowledge/confidential/<tenant>/…`), which no narrow store role is
 * granted yet, so invite I/O runs in the caller's own identity (the operator's
 * confidential persona) and never inside another assumed role. `invite.ts`
 * validates the tenant partition itself. Must not be nested in `asLedgerWriter`.
 */
function asInviteStore<T>(_tenant: string, fn: () => T): T {
  return fn();
}

function audit(
  tenant: string,
  operation: string,
  metadata: Record<string, unknown>,
  agentId = AUDIT_AGENT
): void {
  asLedgerWriter(tenant, () =>
    auditChain.record({
      agentId,
      action: 'customer_decision',
      operation,
      result: 'completed',
      tenantSlug: tenant,
      metadata,
    })
  );
}

function memberActorId(by: string | undefined, label = '--by user:<member>'): string {
  if (!by) throw usageError(`${label} is required`);
  try {
    return humanActor(by.replace(/^user:/u, '')).id;
  } catch {
    throw usageError(`${label} must name a member (user:<member_id>)`);
  }
}

function loadAgenda(
  location: DecisionLedgerLocation,
  tenant: string,
  agendaId: string
): DecisionAgenda {
  const agenda = asLedgerWriter(tenant, () => readAgenda(location, agendaId));
  if (!agenda) throw new ScriptExitError(2, `agenda not found: ${agendaId}`);
  return agenda;
}

function readRepoText(file: string, label: string): string {
  const safe = assertSafeRepositoryPath(file);
  if (!safeExistsSync(safe)) throw new ScriptExitError(2, `${label} not found: ${file}`);
  return String(safeReadFile(safe, { encoding: 'utf8' }));
}

function agendaSummary(agenda: DecisionAgenda): Record<string, unknown> {
  return {
    agenda_id: agenda.agenda_id,
    case_id: agenda.case_id,
    revision: agenda.revision,
    status: agenda.status,
    content_hash: agendaContentHash(agenda),
    entries: agenda.entries.length,
  };
}

/** An entry as the operator may edit it: everything but the pinned decision id. */
function editableEntry(entry: AgendaEntry): AgendaEntry {
  if (!entry.our_decision) return entry;
  const { decision_id: _pinned, ...ours } = entry.our_decision;
  void _pinned;
  return { ...entry, our_decision: ours };
}

function assertUniqueEntries(entries: readonly AgendaEntry[]): void {
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const entry of entries) {
    const pair = `${entry.item}\u0000${entry.key}`;
    if (ids.has(entry.entry_id) || keys.has(pair)) {
      throw new ScriptExitError(
        2,
        `duplicate agenda entry: ${entry.entry_id} (${entry.item} / ${entry.key})`
      );
    }
    ids.add(entry.entry_id);
    keys.add(pair);
  }
}

// ---------------------------------------------------------------------------
// Operator verbs
// ---------------------------------------------------------------------------

function runDraft(opts: Record<string, string>, now: string): unknown {
  const tenant = tenantOf(opts);
  const caseId = requireOpt(opts, 'case');
  const location = locationOf(opts, caseId);
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
    const frozen = current.status === 'approved' || current.status === 'sent';
    const { approval: _approval, ...rest } = current;
    void _approval;
    const next: DecisionAgenda = {
      ...rest,
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
    ...(opts.deal ? { dealId: opts.deal } : {}),
    ...(opts.project ? { projectId: opts.project } : {}),
  });
  assertUniqueEntries(agenda.entries);
  const written = asLedgerWriter(tenant, () => writeAgenda(location, agenda));
  audit(tenant, 'agenda_draft', {
    agenda_id: written.agenda_id,
    case_id: caseId,
    template: template.template_id,
    content_hash: agendaContentHash(written),
  });
  return agendaSummary(written);
}

async function runGenerate(opts: Record<string, string>, now: string): Promise<unknown> {
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
  const written = asLedgerWriter(tenant, () => writeAgenda(location, next));
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

function runSubmit(opts: Record<string, string>, now: string): unknown {
  const tenant = tenantOf(opts);
  const caseId = requireOpt(opts, 'case');
  const location = locationOf(opts, caseId);
  const member = memberActorId(opts.by);
  const role = opts.role === 'approver' ? 'approver' : 'owner';
  const agenda = loadAgenda(location, tenant, requireOpt(opts, 'agenda'));
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

function runActorAdd(opts: Record<string, string>): unknown {
  const tenant = tenantOf(opts);
  const caseId = requireOpt(opts, 'case');
  const location = locationOf(opts, caseId);
  const customer = requireOpt(opts, 'customer');
  if (!CUSTOMER_SLUG_PATTERN.test(customer)) throw usageError('--customer must be a customer slug');
  const actorId = requireOpt(opts, 'actor');
  if (!CUSTOMER_ACTOR_ID_PATTERN.test(actorId)) throw usageError('--actor must be customer:<id>');
  const name = requireOpt(opts, 'name');
  return asLedgerWriter(tenant, () => {
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
      metadata: { customer, actor_id: actorId, decides: actor.decides, updated: Boolean(existing) },
    });
    return { customer, actor, actors: registry.actors.length };
  });
}

function assertSendable(agenda: DecisionAgenda): void {
  const state = agendaAnswerState(agenda);
  if (state.ok === false) {
    throw new ScriptExitError(
      2,
      `agenda ${agenda.agenda_id} is not approved in its current revision (${agenda.status}); run submit first`
    );
  }
}

function runSend(opts: Record<string, string>, now: string): unknown {
  const tenant = tenantOf(opts);
  const caseId = requireOpt(opts, 'case');
  const location = locationOf(opts, caseId);
  const agenda = loadAgenda(location, tenant, requireOpt(opts, 'agenda'));
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
  const { invite, token } = asInviteStore(tenant, () =>
    issueInvite({
      tenantSlug: tenant,
      caseId: agenda.case_id,
      agendaId: agenda.agenda_id,
      participant: { name, role: participantRole, actor_id: actorId },
      createdBy,
      now,
      ttlMs: ttlDays * 24 * 60 * 60 * 1000,
    })
  );
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

function inviteView(invite: CustomerDecisionInvite): Record<string, unknown> {
  const lastUse = invite.uses[invite.uses.length - 1];
  return {
    invite_id: invite.invite_id,
    participant: invite.participant,
    created_at: invite.created_at,
    expires_at: invite.expires_at,
    ...(invite.revoked_at
      ? { revoked_at: invite.revoked_at, revoked_reason: invite.revoked_reason }
      : {}),
    uses: invite.uses.length,
    ...(lastUse ? { last_use: lastUse } : {}),
  };
}

function runStatus(opts: Record<string, string>, now: string): unknown {
  const tenant = tenantOf(opts);
  const caseId = requireOpt(opts, 'case');
  const location = locationOf(opts, caseId);
  const agenda = loadAgenda(location, tenant, requireOpt(opts, 'agenda'));
  const invites = asInviteStore(tenant, () =>
    listInvites(tenant, { agendaId: agenda.agenda_id, caseId: agenda.case_id })
  );
  return asLedgerWriter(tenant, () => {
    const ledger = readLedger(location);
    const effective = resolveAgendaEffective(agenda, ledger, { now });
    const receipts = listReceipts(location, { agendaId: agenda.agenda_id });
    const hash = agendaContentHash(agenda);
    return {
      ...agendaSummary(agenda),
      approval: agenda.approval ?? null,
      approval_current: agenda.approval?.content_hash === hash,
      effective: effective.map((decision) => ({
        entry_id: decision.entry_id,
        item: decision.item,
        key: decision.key,
        layer: decision.layer,
        status: decision.status,
        ...(decision.value !== undefined ? { value: decision.value } : {}),
        ...(decision.decision_id ? { decision_id: decision.decision_id } : {}),
        overridable: decision.overridable,
      })),
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
    };
  });
}

function runRevoke(opts: Record<string, string>, now: string): unknown {
  const tenant = tenantOf(opts);
  const caseId = requireOpt(opts, 'case');
  const inviteId = requireOpt(opts, 'invite');
  const reason = requireOpt(opts, 'reason');
  const revoked = asInviteStore(tenant, () => {
    const invite = listInvites(tenant, { caseId }).find((item) => item.invite_id === inviteId);
    if (!invite) throw new ScriptExitError(2, `invite ${inviteId} not found for case ${caseId}`);
    return revokeInvite(tenant, inviteId, { now, reason });
  });
  audit(tenant, 'invite_revoke', {
    invite_id: revoked.invite_id,
    agenda_id: revoked.agenda_id,
    case_id: revoked.case_id,
    reason,
  });
  return inviteView(revoked);
}

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
  now: string
): {
  tenant: string;
  invite: CustomerDecisionInvite;
  location: DecisionLedgerLocation;
  agenda: DecisionAgenda;
} {
  const tenant = opts.tenant;
  if (!tenant || typeof token !== 'string') throw new CustomerFacingError('invalid_link');
  const verified = asInviteStore(tenant, () => verifyInviteToken(tenant, token, { now, action }));
  if (verified.ok === false) {
    throw new CustomerFacingError(
      verified.reason === 'expired' || verified.reason === 'revoked'
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
      agenda: { title: agenda.title, locale: agenda.locale, revision: agenda.revision },
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
          requires_customer: entry.requires_customer,
          current: {
            status: current?.status ?? 'undecided',
            layer: current?.layer ?? 'none',
            ...(current?.value !== undefined ? { value: current.value } : {}),
          },
          overridable: current?.overridable ?? true,
        };
      }),
      receipts: receiptsForInvite(location, agenda.agenda_id, invite.invite_id).map((receipt) => ({
        receipt_id: receipt.receipt_id,
        submitted_at: receipt.submitted_at,
        revision: receipt.agenda_revision,
        answers: receipt.answers,
      })),
    };
  });
}

function runRespond(
  opts: Record<string, string>,
  input: Record<string, unknown>,
  now: string
): unknown {
  const { tenant, invite, location, agenda } = openInvite(opts, input.token, 'respond', now);
  const receiptId = newReceiptId();
  return asLedgerWriter(tenant, () => {
    const ledger = readLedger(location);
    const planned = planCustomerResponse({
      agenda,
      ledger,
      invite,
      content_hash: input.content_hash,
      answers: input.answers,
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

    // 1. Ledger (all-or-nothing), 2. receipt, 3. switches, 4. reflection.
    const appended = plan.appends.length
      ? appendDecisions(location, plan.appends, { caseId: agenda.case_id }).appended
      : [];
    const decisionIds = appended.map((record) => record.id);
    const receipt = writeReceipt(
      location,
      buildResponseReceipt(plan, agenda, invite, decisionIds, now)
    );
    const after = resolveAgendaEffective(agenda, readLedger(location), { now });
    const switches = appendSwitches(
      location,
      detectSwitches(plan.before, after, {
        case_id: agenda.case_id,
        agenda_id: agenda.agenda_id,
        now,
        cause_receipt_id: receipt.receipt_id,
        newId: newSwitchId,
      })
    );
    writeBriefInput(location, projectBriefInput(agenda, after, now));
    const dealId = agenda.deal_id;
    const dealText =
      dealId && switches.length > 0 ? dealNoteForSwitches(switches, agenda, agenda.locale) : '';
    const dealNoted =
      Boolean(dealId && dealText.trim()) &&
      withExecutionContext(
        DEAL_WRITE_ROLE,
        () => {
          if (!getDeal(tenant, dealId as string)) return false;
          appendDealNote({
            tenantSlug: tenant,
            dealId: dealId as string,
            role: 'kyberion',
            text: dealText,
          });
          return true;
        },
        undefined,
        tenant
      );
    auditChain.record({
      agentId: AUDIT_AGENT,
      action: 'customer_decision',
      operation: 'respond',
      result: 'completed',
      tenantSlug: tenant,
      metadata: {
        agenda_id: agenda.agenda_id,
        case_id: agenda.case_id,
        content_hash: plan.content_hash,
        invite_id: invite.invite_id,
        receipt_id: receipt.receipt_id,
        participant_role: invite.participant.role,
        actor_id: invite.participant.actor_id,
        identity_assurance: receipt.identity_assurance,
        decision_ids: decisionIds,
        switch_ids: switches.map((item) => item.switch_id),
        change_requests: plan.change_requests.map((item) => item.entry_id),
        deal_noted: dealNoted,
      },
    });
    return {
      ok: true,
      receipt_id: receipt.receipt_id,
      switches: switches.length,
      change_requests: plan.change_requests.length,
    };
  });
}

async function runCustomerFacing(
  verb: 'view' | 'respond',
  opts: Record<string, string>,
  io: CustomerDecisionIo,
  now: string
): Promise<unknown> {
  try {
    const raw = io.stdin ?? (await readProcessStdin());
    const input = parseStdinObject(raw);
    return verb === 'view' ? runView(opts, input, now) : runRespond(opts, input, now);
  } catch (error) {
    const failure =
      error instanceof CustomerFacingError
        ? { ok: false, reason: error.reason, ...error.extra }
        : { ok: false, reason: 'unavailable' as const };
    if (!(error instanceof CustomerFacingError)) {
      logger.warn(
        `customer-decision ${verb} failed — ${error instanceof Error ? error.message : String(error)} | check the agenda and stores | customer_decision ${verb}`
      );
    }
    throw new ScriptExitError(1, '', true, failure);
  }
}

export async function runCustomerDecision(
  argv: readonly string[],
  io: CustomerDecisionIo = {}
): Promise<unknown> {
  const { verb, opts } = parseCustomerDecisionArgs(argv);
  const now = io.now ? io.now() : nowIso();
  switch (verb) {
    case 'help':
    case '--help':
    case '-h':
      return usage();
    case 'draft':
      return runDraft(opts, now);
    case 'generate':
      return runGenerate(opts, now);
    case 'submit':
      return runSubmit(opts, now);
    case 'actor-add':
      return runActorAdd(opts);
    case 'send':
      return runSend(opts, now);
    case 'status':
      return runStatus(opts, now);
    case 'revoke':
      return runRevoke(opts, now);
    case 'view':
    case 'respond':
      return runCustomerFacing(verb, opts, io, now);
    default:
      throw usageError(`unknown verb '${verb}'`);
  }
}

export const runCustomerDecisionScript = defineScript({
  name: 'customer-decision',
  flags: ['json', 'quiet'],
  run: async (context) => {
    try {
      const result = await runCustomerDecision(
        context.argv.filter((arg) => arg !== '--json' && arg !== '--quiet')
      );
      context.print(result);
      return result;
    } catch (error) {
      if (error instanceof ScriptExitError) {
        if (error.returnValue !== undefined) context.print(error.returnValue);
        throw error;
      }
      throw new ScriptExitError(2, error instanceof Error ? error.message : String(error));
    }
  },
});

if (
  isDirectScript(import.meta.url, 'customer_decision.ts') ||
  isDirectScript(import.meta.url, 'customer_decision.js')
) {
  void runCustomerDecisionScript(currentProcessArgv().slice(2));
}
