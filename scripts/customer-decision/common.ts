/**
 * Shared plumbing of the customer-decision facade: arguments, locations, roles, audit and agenda helpers.
 * Part of scripts/customer_decision.ts (the entry point); see its header.
 */
import { humanActor } from '@agent/core/actor';
import { withExecutionContext } from '@agent/core/authority';
import { getRegisteredEnvText, isVitestProcess } from '@agent/core/foundation';
import { logger } from '@agent/core/core';
import { auditChain } from '@agent/core/governance/audit-chain';
import { assertSafeRepositoryPath, safeExistsSync, safeReadFile } from '@agent/core/secure-io';
import { appendDealNote, getDeal } from '@agent/core/deal-store';
import { DECISION_LEDGER_ROLES, type DecisionLedgerLocation } from '@agent/core/decision-ledger';
import {
  agendaContentHash,
  dealNoteForSwitches,
  entryLayersProblem,
  isCalendarDate,
  utcDate,
  listAgendas,
  readAgenda,
  withCustomerDecisionCaseLock,
  type AgendaEntry,
  type CustomerDecisionInvite,
  type DecisionAgenda,
  type DecisionSwitch,
} from '@agent/core/customer-decision';
import { ScriptExitError } from '../lib/harness.js';

/** Agendas, receipts, switches, brief input, ledger and customer actors (tenant-bound). */
export const LEDGER_ROLE = DECISION_LEDGER_ROLES.write;
/**
 * Deal notes under `customer/<tenant>/deals/` only: the narrow tenant-bound
 * deal-note writer, never mission_controller — `respond` is customer-triggered.
 */
export const DEAL_NOTE_ROLE = 'customer_decision_deal_note_writer';

export const AGENDA_APPROVE_OPERATION = 'customer_decision:agenda_approve';
export const OPERATOR_CONFIRM_OPERATION = 'customer_decision:operator_confirm';
export const APPROVAL_CHANNEL = 'terminal';
export const AUDIT_AGENT = 'customer-decision';
export const DEFAULT_TEMPLATE = 'aidlc-inception';
export const DEFAULT_ROOM_URL = 'http://127.0.0.1:3046';
export const MAX_STDIN_BYTES = 256 * 1024;

export interface ParsedArgs {
  verb: string;
  opts: Record<string, string>;
  flags: Set<string>;
  /** Every value of an option given more than once (`--attach a.png --attach b.png`), in order. */
  lists: Record<string, string[]>;
}

export interface CustomerDecisionIo {
  /** STDIN text for `view` / `respond` (tests); defaults to reading process.stdin. */
  stdin?: string;
  /** Clock override (tests). */
  now?: () => string;
  /**
   * The decision case a mission resolves to (tests); defaults to
   * `resolveMissionDecisionCase` (the mission's project, else a deal listing it).
   */
  missionCase?: (
    missionId: string
  ) => { tenantSlug: string; caseId: string; projectId?: string } | null;
}

export function parseCustomerDecisionArgs(argv: readonly string[]): ParsedArgs {
  const [verb = 'help', ...rest] = argv;
  const opts: Record<string, string> = {};
  const flags = new Set<string>();
  const lists: Record<string, string[]> = {};
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg.startsWith('--')) continue;
    const name = arg.slice(2);
    const next = rest[index + 1];
    if (next === undefined || next.startsWith('--')) {
      flags.add(name);
    } else {
      opts[name] = next;
      (lists[name] ??= []).push(next);
      index += 1;
    }
  }
  return { verb, opts, flags, lists };
}

export function usage(): string {
  return [
    'pnpm kyberion customer-decision draft     --tenant <slug> --case <id> --customer <slug> [--template aidlc-inception] [--title <t>] [--from <text>] [--locale ja|en] [--deal <id>] [--project <id>] [--respond-by <YYYY-MM-DD>]',
    'pnpm kyberion customer-decision draft     --tenant <slug> --case <id> --agenda <id> [--file <agenda.json>] [--respond-by <YYYY-MM-DD>|none]',
    'pnpm kyberion customer-decision draft     --tenant <slug> --case <id> --from-tasks [--agenda <draft id>] [--customer <slug>] [--title <t>] [--locale ja|en]',
    'pnpm kyberion customer-decision generate  --tenant <slug> --case <id> --agenda <id> --intent-file <path> [--grounding-file <path>]',
    'pnpm kyberion customer-decision submit    --tenant <slug> --case <id> --agenda <id> --by user:<member> [--role owner|approver]',
    'pnpm kyberion customer-decision actor-add --tenant <slug> --case <id> --customer <slug> --actor customer:<id> --name <text> [--confirm-target <text>] [--channel <surface>:<channel_id>|none]',
    'pnpm kyberion customer-decision send      --tenant <slug> --case <id> --agenda <id> --name <participant> --role decider|contributor --actor customer:<id> [--ttl-days 14] [--by user:<member>]',
    'pnpm kyberion customer-decision bolt-review --tenant <slug> --case <id> --mission <MSN> --customer <slug> --summary-file <path> [--attach <png|jpeg|webp>]... [--preview-url <https URL>] [--title <t>] [--from <text>] [--locale ja|en] [--project <id>] [--by user:<member>]',
    'pnpm kyberion customer-decision status    --tenant <slug> --case <id> [--agenda <id>]',
    'pnpm kyberion customer-decision confirm   --tenant <slug> --case <id> --agenda <id> --entry <entry_id> --by user:<member>',
    'pnpm kyberion customer-decision close     --tenant <slug> --case <id> --agenda <id> --by user:<member> [--reason <text>]',
    'pnpm kyberion customer-decision withdraw  --tenant <slug> --case <id> --agenda <id> --by user:<member> [--reason <text>]',
    'pnpm kyberion customer-decision revoke    --tenant <slug> --case <id> --invite <id> --reason <text>',
    'pnpm kyberion customer-decision remind    --tenant <slug> [--case <id>] [--dry-run] [--now <iso>]',
    'pnpm kyberion customer-decision reminders --tenant <slug> --install --by user:<member> [--force] [--dry-run]',
    'pnpm kyberion customer-decision overview  --tenant <slug> [--case <id>] [--now <iso>] --json   (read-only)',
    'pnpm kyberion customer-decision learning  --tenant <slug> [--since <date>] [--dry-run] [--now <iso>] [--organization-id <id>]',
    'pnpm kyberion customer-decision learning  --tenant <slug> --install --by user:<member> [--force] [--dry-run]',
    'pnpm kyberion customer-decision view      --tenant <slug> [--case <id>] --json   (stdin: {"token"})',
    'pnpm kyberion customer-decision respond   --tenant <slug> [--case <id>] --json   (stdin: {"token","content_hash","answers","general_question"?})',
    'pnpm kyberion customer-decision attachment --tenant <slug> [--case <id>] --json  (stdin: {"token","attachment_id"})',
    '',
    'send prints the invite link once; forward it to the customer yourself.',
    "Reminders (remind / the daily tenant pipeline) go through the decider's bound channel via sendToCustomer.",
    'learning queues suggestions as organization learning candidates; accept one with pnpm organization learning transition.',
  ].join('\n');
}

/**
 * CD-11 `--respond-by`: a real `YYYY-MM-DD` date, not before today (UTC);
 * `none` clears it (null). Undefined when the option is absent.
 */
export function parseRespondBy(value: string | undefined, now: string): string | null | undefined {
  if (value === undefined) return undefined;
  const date = value.trim();
  if (date === 'none') return null;
  if (!isCalendarDate(date)) throw usageError('--respond-by must be a date (YYYY-MM-DD) or none');
  const today = utcDate(now);
  if (today && date < today)
    throw usageError(`--respond-by ${date} is in the past (today is ${today} UTC)`);
  return date;
}

export function usageError(message: string): ScriptExitError {
  return new ScriptExitError(2, `${message}\n${usage()}`);
}

export function requireOpt(opts: Record<string, string>, name: string): string {
  const value = opts[name];
  if (!value || !value.trim()) throw usageError(`--${name} is required`);
  return value.trim();
}

export function tenantOf(opts: Record<string, string>): string {
  return requireOpt(opts, 'tenant');
}

/** `--dir` (a scratch case directory) exists for hermetic tests only. */
export function isTestRun(): boolean {
  return isVitestProcess() || getRegisteredEnvText('NODE_ENV') === 'test';
}

export function locationOf(opts: Record<string, string>, caseId: string): DecisionLedgerLocation {
  if (opts.dir !== undefined) {
    if (!isTestRun()) throw usageError('--dir is only accepted in test runs');
    return { dir: opts.dir };
  }
  return { tenantSlug: tenantOf(opts), caseId };
}

export function withCaseLock<T>(location: DecisionLedgerLocation, fn: () => T): T {
  return withCustomerDecisionCaseLock(location, fn);
}

export function asLedgerWriter<T>(tenant: string, fn: () => T): T {
  return withExecutionContext(LEDGER_ROLE, fn, undefined, tenant);
}

export function audit(
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

export function memberActorId(by: string | undefined, label = '--by user:<member>'): string {
  if (!by) throw usageError(`${label} is required`);
  try {
    return humanActor(by.replace(/^user:/u, '')).id;
  } catch {
    throw usageError(`${label} must name a member (user:<member_id>)`);
  }
}

export function loadAgenda(
  location: DecisionLedgerLocation,
  tenant: string,
  agendaId: string
): DecisionAgenda {
  const agenda = asLedgerWriter(tenant, () => readAgenda(location, agendaId));
  if (!agenda) throw new ScriptExitError(2, `agenda not found: ${agendaId}`);
  return agenda;
}

export function readRepoText(file: string, label: string): string {
  const safe = assertSafeRepositoryPath(file);
  if (!safeExistsSync(safe)) throw new ScriptExitError(2, `${label} not found: ${file}`);
  return String(safeReadFile(safe, { encoding: 'utf8' }));
}

export function agendaSummary(agenda: DecisionAgenda): Record<string, unknown> {
  return {
    agenda_id: agenda.agenda_id,
    case_id: agenda.case_id,
    revision: agenda.revision,
    status: agenda.status,
    ...(agenda.from ? { from: agenda.from } : {}),
    ...(agenda.respond_by ? { respond_by: agenda.respond_by } : {}),
    content_hash: agendaContentHash(agenda),
    entries: agenda.entries.length,
  };
}

/** An entry as the operator may edit it: everything but the pinned decision id. */
export function editableEntry(entry: AgendaEntry): AgendaEntry {
  if (!entry.our_decision) return entry;
  const { decision_id: _pinned, ...ours } = entry.our_decision;
  void _pinned;
  return { ...entry, our_decision: ours };
}

export function itemKey(entry: Pick<AgendaEntry, 'item' | 'key'>): string {
  return `${entry.item}\u0000${entry.key}`;
}

/** Unique ids and item × key within the agenda, and a layer order that starts with the customer. */
export function assertUniqueEntries(entries: readonly AgendaEntry[]): void {
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
export function assertNoOpenAgendaOverlap(
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

export function inviteView(invite: CustomerDecisionInvite): Record<string, unknown> {
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
export function auditFailure(
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
export function noteDealSwitches(
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
