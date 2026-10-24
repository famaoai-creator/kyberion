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
 * `CustomerDecisionOverview` (`libs/core/customer-decision/overview.ts`).
 */
import { resolveIdentityContext } from '@agent/core/authority';
import { logger } from '@agent/core/core';
import { isValidCaseId, readLedger } from '@agent/core/decision-ledger';
import {
  buildCaseOverview,
  buildCustomerDecisionOverview,
  listAgendas,
  listConsumedDecisionLocks,
  listInvites,
  listReceipts,
  listTenantCaseIds,
  type CaseOverview,
  type CustomerDecisionInvite,
  type CustomerDecisionOverview,
} from '@agent/core/customer-decision';
import { ScriptExitError } from '../lib/harness.js';
import { asLedgerWriter, diagnosticCode, tenantOf, usageError } from './common.js';

/**
 * `--tenant`, refused when this process is bound to another tenant (its
 * identity's tenant: `KYBERION_TENANT`, the binding a Chronos tenant child
 * runs with): a tenant-scoped caller never reads another tenant through this
 * facade. An unbound operator CLI names the tenant with `--tenant`.
 */
export function boundTenantOf(opts: Record<string, string>): string {
  const tenant = tenantOf(opts);
  const bound = resolveIdentityContext().tenantSlug?.trim();
  if (bound && bound !== tenant) {
    throw new ScriptExitError(
      2,
      `[CUSTOMER_DECISION_TENANT_MISMATCH] --tenant ${tenant} differs from the tenant this process is bound to (KYBERION_TENANT); run it for the bound tenant`
    );
  }
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
  if (!all.includes(wanted)) throw new ScriptExitError(2, `case not found: ${wanted}`);
  return [wanted];
}

function caseOverview(
  tenant: string,
  caseId: string,
  invites: readonly CustomerDecisionInvite[],
  now: string
): CaseOverview {
  const location = { tenantSlug: tenant, caseId };
  return asLedgerWriter(tenant, () =>
    buildCaseOverview({
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
    })
  );
}

/** `overview --tenant <t> [--case <c>] [--now <iso>]` */
export function runOverview(opts: Record<string, string>, now: string): CustomerDecisionOverview {
  const tenant = boundTenantOf(opts);
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
  return buildCustomerDecisionOverview({
    tenant_slug: tenant,
    cases,
    case_failures: failures,
    now: at,
  });
}
