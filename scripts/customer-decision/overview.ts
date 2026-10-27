/**
 * CD-12: `customer-decision overview` — the read-only tenant overview the
 * Chronos organization view runs as a tenant-bound facade child (wave 2).
 * Part of scripts/customer_decision.ts (the entry point); see its header.
 *
 * Reads only: the tenant's case directories, each case's agendas, ledger,
 * receipts and consumer locks (as the tenant-bound `decision_ledger` role),
 * and the tenant's invites (through the invite store role). It takes no case
 * lock and never reconciles, routes, notifies or audits — `status` does
 * those, so it is never called from here. The JSON contract is
 * `CustomerDecisionOverview` (`libs/core/customer-decision/overview.ts`);
 * `--case <c> --detail` prints `CustomerDecisionCaseDetail` (`case-detail.ts`)
 * and `--learning [--date <d>]` prints `CustomerDecisionLearningView`
 * (`learning-view.ts`, read from the tenant's stored learning reports).
 */
import { logger } from '@agent/core/core';
import { isValidCaseId, readLedger } from '@agent/core/decision-ledger';
import {
  buildCaseOverview,
  buildCustomerDecisionCaseDetail,
  buildCustomerDecisionOverview,
  emptyLearningView,
  isCalendarDate,
  listAgendas,
  listConsumedDecisionLocks,
  listInvites,
  listLearningReportDates,
  listReceipts,
  listTenantCaseIds,
  projectLearningReport,
  readLearningReport,
  summarizeCustomerDecisionOverview,
  type CaseOverview,
  type CaseOverviewInput,
  type CustomerDecisionCaseDetail,
  type CustomerDecisionInvite,
  type CustomerDecisionLearningView,
  type CustomerDecisionOverview,
} from '@agent/core/customer-decision';
import { ScriptExitError } from '../lib/harness.js';
import { asLedgerWriter, diagnosticCode, tenantOf, usageError } from './common.js';
import { isApprovedSupersededConsumerLock } from './superseded-locks.js';

/**
 * `--tenant` (bound-tenant check in `tenantOf`); tenant-wide verbs take no
 * `--dir`.
 */
export function boundTenantOf(opts: Record<string, string>): string {
  const tenant = tenantOf(opts);
  if (opts.dir !== undefined) throw usageError('--dir is not accepted by tenant-wide verbs');
  return tenant;
}

/** `--now <iso>` (tests, replays), else the clock. */
export function nowOf(opts: Record<string, string>, now: string): string {
  const at = opts.now?.trim() || now;
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) throw usageError('--now must be an ISO timestamp');
  return new Date(ms).toISOString();
}

/** The case ids to scan: every case of the tenant, or the one `--case` names (it must exist). */
export function selectedCaseIds(tenant: string, opts: Record<string, string>): string[] {
  const all = asLedgerWriter(tenant, () => listTenantCaseIds(tenant));
  const wanted = opts.case?.trim();
  if (!wanted) return all;
  if (!isValidCaseId(wanted)) throw usageError('--case must be a case id');
  if (!all.includes(wanted))
    throw new ScriptExitError(2, `[CUSTOMER_DECISION_CASE_NOT_FOUND] case not found: ${wanted}`);
  return [wanted];
}

/** What one case's overview (and detail) is built from, read as the tenant-bound ledger role. */
function caseInput(
  tenant: string,
  caseId: string,
  invites: readonly CustomerDecisionInvite[],
  now: string
): CaseOverviewInput {
  const location = { tenantSlug: tenant, caseId };
  return asLedgerWriter(tenant, () => ({
    case_id: caseId,
    agendas: listAgendas(location),
    ledger: readLedger(location),
    receipts: listReceipts(location),
    invites: invites.filter((invite) => invite.case_id === caseId),
    consumers: listConsumedDecisionLocks(location, (consumer, error) =>
      logger.warn(
        `customer-decision overview: consumer lock skipped — ${diagnosticCode(error)} | the other locks are read; repair or remove the lock | ${consumer}`
      )
    ),
    now,
    isSuperseded: (lock) => isApprovedSupersededConsumerLock(tenant, lock),
  }));
}

function caseOverview(
  tenant: string,
  caseId: string,
  invites: readonly CustomerDecisionInvite[],
  now: string
): CaseOverview {
  return buildCaseOverview(caseInput(tenant, caseId, invites, now));
}

/**
 * `overview --tenant <t> --case <c> --detail [--now <iso>]` — one case for
 * the drill-down views. A case that cannot be read fails with its code.
 */
function runCaseDetail(
  tenant: string,
  opts: Record<string, string>,
  now: string
): CustomerDecisionCaseDetail {
  if (!opts.case?.trim()) throw usageError('--detail needs --case <id>');
  const [caseId] = selectedCaseIds(tenant, opts);
  const invites = listInvites(tenant, { caseId });
  return buildCustomerDecisionCaseDetail({
    ...caseInput(tenant, caseId, invites, now),
    tenant_slug: tenant,
  });
}

/**
 * `overview --tenant <t> --learning [--date YYYY-MM-DD]` — the stored
 * learning report of that date (the latest when omitted; `report_date: null`
 * when the tenant has none). Never computes or writes a report.
 */
function runLearningView(
  tenant: string,
  opts: Record<string, string>
): CustomerDecisionLearningView {
  if (opts.case !== undefined) throw usageError('--learning takes no --case');
  const wanted = opts.date?.trim();
  if (wanted !== undefined && !isCalendarDate(wanted))
    throw usageError('--date must be a date (YYYY-MM-DD)');
  return asLedgerWriter(tenant, () => {
    const dates = listLearningReportDates(tenant);
    const date = wanted ?? dates.at(-1);
    if (date === undefined) return emptyLearningView(tenant, dates);
    const report = dates.includes(date) ? readLearningReport(tenant, date) : undefined;
    if (!report)
      throw new ScriptExitError(
        2,
        `[CUSTOMER_DECISION_REPORT_NOT_FOUND] learning report not found: ${date}`
      );
    return projectLearningReport(report, dates);
  });
}

/**
 * `overview --tenant <t> [--case <c>] [--now <iso>] [--summary]` — `--summary`
 * omits the entries of each agenda and caps `attention` (with
 * `totals.attention_total`); see `summarizeCustomerDecisionOverview`.
 * `--detail` (with `--case`) and `--learning` print the drill-down views.
 */
export function runOverview(
  opts: Record<string, string>,
  flags: ReadonlySet<string>,
  now: string
): CustomerDecisionOverview | CustomerDecisionCaseDetail | CustomerDecisionLearningView {
  const tenant = boundTenantOf(opts);
  const views = ['summary', 'detail', 'learning'].filter((flag) => flags.has(flag));
  if (views.length > 1) throw usageError(`--${views.join(' and --')} cannot be combined`);
  if (flags.has('learning')) return runLearningView(tenant, opts);
  if (flags.has('detail')) return runCaseDetail(tenant, opts, nowOf(opts, now));
  const at = nowOf(opts, now);
  const caseIds = selectedCaseIds(tenant, opts);
  const wanted = opts.case?.trim();
  // Invite I/O runs inside invite.ts as the tenant-bound invite store role.
  const invites = caseIds.length > 0 ? listInvites(tenant, wanted ? { caseId: wanted } : {}) : [];
  const cases: CaseOverview[] = [];
  const failures: Array<{ case_id: string; diagnostic_code: string }> = [];
  for (const caseId of caseIds) {
    try {
      cases.push(caseOverview(tenant, caseId, invites, at));
    } catch (error) {
      const code = diagnosticCode(error);
      failures.push({ case_id: caseId, diagnostic_code: code });
      logger.warn(
        `customer-decision overview skipped a case — ${code} | the other cases are shown; run customer-decision status --tenant ${tenant} --case ${caseId} | case=${caseId}`
      );
    }
  }
  const overview = buildCustomerDecisionOverview({
    tenant_slug: tenant,
    cases,
    case_failures: failures,
    now: at,
  });
  return flags.has('summary') ? summarizeCustomerDecisionOverview(overview) : overview;
}
