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
 *   status   --agenda <id>                              also completes interrupted responses
 *   confirm  --agenda <id> --entry <entry_id> --by user:<member>   confirm a customer decision on a requires_customer entry
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
 * `--dir <path>` (test runs only: refused unless VITEST or NODE_ENV=test)
 * replaces the case directory; invites still live in the tenant's runtime
 * partition.
 *
 * Consistency: every read → plan → write sequence on a case runs under the
 * case lock (`withCustomerDecisionCaseLock`). `respond` writes a write-ahead
 * journal record before the ledger append (receipt with pre-assigned decision
 * ids + the effective decisions before), then ledger → receipt → audit →
 * switches → brief input, and removes the record. A run that stopped part way
 * is completed by the next respond / confirm / submit / status of the case
 * (`reconcileCase`). The deal note is best-effort and never fails a respond.
 */
import { humanActor } from '@agent/core/actor';
import { withExecutionContext, withExecutionContextAsync } from '@agent/core/authority';
import { getRegisteredEnvText, isVitestProcess, nowIso, readJson } from '@agent/core/foundation';
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
  entryLayersProblem,
  findDuplicateReceipt,
  generateAgendaDraft,
  instantiateTemplate,
  issueInvite,
  isActiveCustomerDecision,
  listAgendas,
  listInvites,
  listReceipts,
  listRespondJournals,
  loadDecisionTemplate,
  newAgendaId,
  newReceiptId,
  newSwitchId,
  openChangeRequests,
  planCustomerResponse,
  projectBriefInput,
  readAgenda,
  readReceipt,
  readSwitches,
  removeRespondJournal,
  resolveAgendaEffective,
  revokeInvite,
  verifyInviteToken,
  withCustomerDecisionCaseLock,
  writeAgenda,
  writeBriefInput,
  writeReceipt,
  writeRespondJournal,
  type AgendaEntry,
  type CustomerDecisionInvite,
  type DecisionAgenda,
  type DecisionSwitch,
  type EffectiveDecision,
  type RespondJournalRecord,
} from '@agent/core/customer-decision';
import {
  currentProcessArgv,
  defineScript,
  isDirectScript,
  ScriptExitError,
} from './lib/harness.js';

/** Agendas, receipts, switches, brief input, ledger and customer actors (tenant-bound). */
const LEDGER_ROLE = DECISION_LEDGER_ROLES.write;
/**
 * Deal notes under `customer/<tenant>/deals/` only: the narrow tenant-bound
 * deal-note writer, never mission_controller — `respond` is customer-triggered.
 */
const DEAL_NOTE_ROLE = 'customer_decision_deal_note_writer';

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
    'pnpm kyberion customer-decision confirm   --tenant <slug> --case <id> --agenda <id> --entry <entry_id> --by user:<member>',
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

/** `--dir` (a scratch case directory) exists for hermetic tests only. */
function isTestRun(): boolean {
  return isVitestProcess() || getRegisteredEnvText('NODE_ENV') === 'test';
}

function locationOf(opts: Record<string, string>, caseId: string): DecisionLedgerLocation {
  if (opts.dir !== undefined) {
    if (!isTestRun()) throw usageError('--dir is only accepted in test runs');
    return { dir: opts.dir };
  }
  return { tenantSlug: tenantOf(opts), caseId };
}

function withCaseLock<T>(location: DecisionLedgerLocation, fn: () => T): T {
  return withCustomerDecisionCaseLock(location, fn);
}

function asLedgerWriter<T>(tenant: string, fn: () => T): T {
  return withExecutionContext(LEDGER_ROLE, fn, undefined, tenant);
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

function itemKey(entry: Pick<AgendaEntry, 'item' | 'key'>): string {
  return `${entry.item}\u0000${entry.key}`;
}

/** Unique ids and item × key within the agenda, and a layer order that starts with the customer. */
function assertUniqueEntries(entries: readonly AgendaEntry[]): void {
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const entry of entries) {
    const pair = itemKey(entry);
    if (ids.has(entry.entry_id) || keys.has(pair)) {
      throw new ScriptExitError(
        2,
        `duplicate agenda entry: ${entry.entry_id} (${entry.item} / ${entry.key})`
      );
    }
    const layers = entryLayersProblem(entry);
    if (layers) {
      throw new ScriptExitError(
        2,
        `agenda entry ${entry.entry_id}: ${layers} — an explicit layer order must start with "customer"`
      );
    }
    ids.add(entry.entry_id);
    keys.add(pair);
  }
}

/**
 * One item × key is asked in one open agenda of a case: two open agendas
 * would resolve and switch the same ledger value independently.
 */
function assertNoOpenAgendaOverlap(
  location: DecisionLedgerLocation,
  tenant: string,
  agendaId: string,
  entries: readonly AgendaEntry[]
): void {
  const wanted = new Map(entries.map((entry) => [itemKey(entry), entry]));
  const others = asLedgerWriter(tenant, () => listAgendas(location)).filter(
    (agenda) =>
      agenda.agenda_id !== agendaId && agenda.status !== 'closed' && agenda.status !== 'withdrawn'
  );
  for (const other of others) {
    for (const entry of other.entries) {
      const mine = wanted.get(itemKey(entry));
      if (mine) {
        throw new ScriptExitError(
          2,
          `agenda entry ${mine.entry_id} (${mine.item} / ${mine.key}) is already asked in open agenda ${other.agenda_id} (${entry.entry_id}); withdraw or close it first`
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Operator verbs
// ---------------------------------------------------------------------------

function runDraft(opts: Record<string, string>, now: string): unknown {
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
    const next: DecisionAgenda = {
      ...rest,
      ...(inForce ? { in_force: inForce } : {}),
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

function runSubmit(opts: Record<string, string>, now: string): unknown {
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

// ---------------------------------------------------------------------------
// Completion and recovery of respond runs (all under the case lock)
// ---------------------------------------------------------------------------

/**
 * A stable, prose-free diagnostic code for an unexpected error: the first
 * `[CODE]` in its message, else `UNEXPECTED_<NAME>`. Never carries the message
 * itself (it may hold paths or request data) and never the invite token.
 */
export function diagnosticCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const match = /\[([A-Z][A-Z0-9_]{2,63})\]/u.exec(message);
  if (match) return match[1];
  const name = error instanceof Error ? error.name : '';
  return /^[A-Za-z]{1,40}$/u.test(name) && name !== 'Error'
    ? `UNEXPECTED_${name.toUpperCase()}`
    : 'UNEXPECTED';
}

/** An audit entry for a failed step; itself best-effort (the store may be the problem). */
function auditFailure(
  tenant: string | undefined,
  operation: string,
  reason: string,
  metadata: Record<string, unknown> = {}
): void {
  if (!tenant) return;
  try {
    asLedgerWriter(tenant, () =>
      auditChain.record({
        agentId: AUDIT_AGENT,
        action: 'customer_decision',
        operation,
        result: 'failed',
        reason,
        tenantSlug: tenant,
        metadata: { ...metadata, diagnostic_code: reason },
      })
    );
  } catch (error) {
    logger.warn(
      `customer-decision audit of a failed ${operation} not recorded — ${diagnosticCode(error)} | check the audit chain store | reason=${reason}`
    );
  }
}

/**
 * The deal note for decision switches: best-effort, as the narrow tenant-bound
 * deal-note writer. A failure is logged and audited, never thrown — the
 * decision is already recorded.
 */
function noteDealSwitches(
  tenant: string,
  agenda: DecisionAgenda,
  switches: readonly DecisionSwitch[]
): boolean {
  const dealId = agenda.deal_id;
  if (!dealId || switches.length === 0) return false;
  try {
    const text = dealNoteForSwitches([...switches], agenda, agenda.locale);
    if (!text.trim()) return false;
    return withExecutionContext(
      DEAL_NOTE_ROLE,
      () => {
        if (!getDeal(tenant, dealId)) return false;
        appendDealNote({ tenantSlug: tenant, dealId, role: 'kyberion', text });
        return true;
      },
      undefined,
      tenant
    );
  } catch (error) {
    const code = diagnosticCode(error);
    logger.warn(
      `customer-decision deal note skipped — ${code} | the decision is recorded; add the deal note by hand | deal=${dealId} agenda=${agenda.agenda_id}`
    );
    auditFailure(tenant, 'deal_note', code, {
      agenda_id: agenda.agenda_id,
      deal_id: dealId,
      switch_ids: switches.map((item) => item.switch_id),
    });
    return false;
  }
}

/**
 * Finish a respond run whose ledger step is done: receipt (if missing) →
 * audit → switches (only those not yet recorded for this receipt) → brief
 * input → remove the journal record. Every step is idempotent, so a run cut
 * off anywhere completes on retry. Runs as the ledger writer, under the lock.
 */
function completeRespond(
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
  if (journal.stage === 'receipt_written') {
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

interface ReconcileReport {
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
 */
function reconcileCase(
  tenant: string,
  location: DecisionLedgerLocation,
  now: string
): ReconcileReport {
  return asLedgerWriter(tenant, () => {
    const report: ReconcileReport = { completed: [], abandoned: [], stuck: [] };
    const journals = listRespondJournals(location, (receiptId, error) =>
      report.stuck.push({ receipt_id: receiptId, reason: diagnosticCode(error) })
    );
    for (const journal of journals) {
      const agenda = readAgenda(location, journal.agenda_id);
      if (!agenda) {
        report.stuck.push({ receipt_id: journal.receipt_id, reason: 'agenda_missing' });
        continue;
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
        continue;
      }
      if (applied.length !== ids.length) {
        report.stuck.push({ receipt_id: journal.receipt_id, reason: 'ledger_mismatch' });
        continue;
      }
      const done = completeRespond(tenant, location, agenda, journal, now, true);
      noteDealSwitches(tenant, agenda, done.appended);
      report.completed.push(journal.receipt_id);
    }
    if (report.stuck.length > 0) {
      logger.warn(
        `customer-decision respond journal not reconciled — ${report.stuck.map((item) => `${item.receipt_id}:${item.reason}`).join(', ')} | inspect <case>/respond-journal/ and the ledger | customer_decision status`
      );
    }
    return report;
  });
}

/**
 * Customer decisions of this agenda whose evidence receipt does not exist and
 * that no journal record can complete (written outside the facade, or lost).
 */
function unreconciledDecisions(
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

function runStatus(opts: Record<string, string>, now: string): unknown {
  const tenant = tenantOf(opts);
  const caseId = requireOpt(opts, 'case');
  const location = locationOf(opts, caseId);
  const agendaId = requireOpt(opts, 'agenda');
  return withCaseLock(location, () => {
    const reconciled = reconcileCase(tenant, location, now);
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
      };
    });
  });
}

/**
 * CD-08 / 決定の層 row 1: confirm the customer's decision on a
 * `requires_customer` (money / contract) entry. Refused unless the entry's
 * effective decision is a customer decision; idempotent for the same
 * decision id (and re-adds the `confirmed` switch if a cut-off run lost it).
 */
function runConfirm(opts: Record<string, string>, now: string): unknown {
  const tenant = tenantOf(opts);
  const caseId = requireOpt(opts, 'case');
  const location = locationOf(opts, caseId);
  const agendaId = requireOpt(opts, 'agenda');
  const entryId = requireOpt(opts, 'entry');
  const member = memberActorId(opts.by);
  return withCaseLock(location, () => {
    reconcileCase(tenant, location, now);
    return asLedgerWriter(tenant, () => {
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
            { entry_id: entryId, decision_id: decisionId, by: member, at: now },
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
        status: after.find((decision) => decision.entry_id === entryId)?.status,
        already_confirmed: alreadyConfirmed,
        switches: switches.length,
        deal_noted: dealNoted,
      };
    });
  });
}

function runRevoke(opts: Record<string, string>, now: string): unknown {
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
  const verified = verifyInviteToken(tenant, token, { now, action });
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
  const { tenant, invite, location } = openInvite(opts, input.token, 'respond', now);
  return withCaseLock(location, () => {
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
}

async function runCustomerFacing(
  verb: 'view' | 'respond',
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
    case 'confirm':
      return runConfirm(opts, now);
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
