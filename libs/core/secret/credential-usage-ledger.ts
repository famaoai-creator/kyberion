/**
 * Usage ledger of lent reasoning credentials (design §6).
 *
 * No new store: every reasoning run already appends one execution-metrics row
 * to the run's tenant partition (`active/shared/runtime/execution-metrics/<tier>/<tenant>/`,
 * analysis/metrics.ts, retention per storage-retention-catalog). While a lent
 * credential is bound, the metering funnel (`recordCliUsage`, the anthropic
 * SDK backend) stamps the row with `credential_ref` / `credential_kind` /
 * `credential_grant_id` (`credentialUsageFields`). This module reads those rows
 * back per borrower tenant and month, and judges the lending budget:
 * 80% notifies, 100% stops new runs (`[CREDENTIAL_BUDGET_EXCEEDED]`, classified
 * as a credential_grant refusal).
 */
import { metrics } from '../analysis/metrics.js';
import {
  currentTaskCredentialSource,
  resolveTaskCredentialKind,
} from '../foundation/credential-binding.js';
import { calendarDateInZone } from '../temporal/business-calendar.js';
import { installationTimezone } from '../temporal/temporal-context.js';
import type { CredentialLendingScope } from './credential-custody.js';

/** Row stamp added by the metering funnel; empty outside a lent binding. */
export function credentialUsageFields(): Record<string, string> {
  try {
    const source = currentTaskCredentialSource();
    if (!source) return {};
    let kind: string | undefined;
    try {
      kind = resolveTaskCredentialKind();
    } catch {
      kind = undefined;
    }
    return {
      credential_ref: source.credentialRef,
      credential_grant_id: source.allocationGrantId,
      ...(kind ? { credential_kind: kind } : {}),
    };
  } catch {
    return {};
  }
}

export interface CredentialUsageRow {
  at: string;
  borrower_tenant: string;
  credential_ref: string;
  kind?: string;
  backend: string;
  input_tokens: number;
  output_tokens: number;
  est_cost_usd: number;
}

export interface CredentialUsageSummary {
  borrower_tenant: string;
  month: string;
  credential_ref: string;
  runs: number;
  input_tokens: number;
  output_tokens: number;
  est_cost_usd: number;
}

/** Reads one tenant's execution-metrics rows (test seam). */
export type CredentialUsageHistory = (tenant: string) => Record<string, any>[];

const defaultHistory: CredentialUsageHistory = (tenant) =>
  metrics.loadHistory({ read: { tenants: [tenant] } });

const num = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;

/**
 * Budget months are business months in the installation timezone — the OS
 * timezone reported by Intl (temporal-context `installationTimezone`, UTC
 * fallback) — the same zone the `credential-usage-monthly` Chronos job is
 * scheduled in, so the ledger, the report, the alerts and the bind-time stop
 * agree.
 */
export function credentialBudgetTimezone(): string {
  return installationTimezone();
}
export function monthOf(date: Date, timeZone: string = credentialBudgetTimezone()): string {
  const { year, month } = calendarDateInZone(date, timeZone);
  return `${year}-${String(month).padStart(2, '0')}`;
}

export function credentialUsageRows(
  tenant: string,
  options: { month?: string; history?: CredentialUsageHistory } = {}
): CredentialUsageRow[] {
  const rows = (options.history ?? defaultHistory)(tenant);
  const out: CredentialUsageRow[] = [];
  for (const row of rows) {
    if (typeof row?.credential_ref !== 'string') continue;
    if (row.scope?.tenant_slug !== tenant) continue;
    const at = String(row.timestamp ?? '');
    const atMs = Date.parse(at);
    if (options.month && (!Number.isFinite(atMs) || monthOf(new Date(atMs)) !== options.month))
      continue;
    const usage = row.usage ?? {};
    out.push({
      at,
      borrower_tenant: tenant,
      credential_ref: row.credential_ref,
      ...(typeof row.credential_kind === 'string' ? { kind: row.credential_kind } : {}),
      backend: String(row.agent ?? row.component ?? 'unknown'),
      input_tokens:
        num(usage.prompt_tokens) +
        num(usage.cache_read_tokens) +
        num(usage.cache_write_tokens) +
        num(usage.cache_write_1h_tokens),
      output_tokens: num(usage.completion_tokens),
      // A subscription run reports an API-list equivalent; it is still the best early warning.
      est_cost_usd: num(row.cost_usd) || num(row.reference_cost_usd),
    });
  }
  return out;
}

export function summarizeCredentialUsage(
  tenant: string,
  month: string,
  options: { history?: CredentialUsageHistory } = {}
): CredentialUsageSummary[] {
  const byRef = new Map<string, CredentialUsageSummary>();
  for (const row of credentialUsageRows(tenant, { month, history: options.history })) {
    const entry = byRef.get(row.credential_ref) ?? {
      borrower_tenant: tenant,
      month,
      credential_ref: row.credential_ref,
      runs: 0,
      input_tokens: 0,
      output_tokens: 0,
      est_cost_usd: 0,
    };
    entry.runs += 1;
    entry.input_tokens += row.input_tokens;
    entry.output_tokens += row.output_tokens;
    entry.est_cost_usd = Math.round((entry.est_cost_usd + row.est_cost_usd) * 100000) / 100000;
    byRef.set(row.credential_ref, entry);
  }
  return [...byRef.values()].sort((a, b) => a.credential_ref.localeCompare(b.credential_ref));
}

export type CredentialBudgetStatus = 'unbounded' | 'ok' | 'warn' | 'exceeded';
export const CREDENTIAL_BUDGET_WARN_RATIO = 0.8;

export interface CredentialBudgetAssessment {
  status: CredentialBudgetStatus;
  spent_usd: number;
  budget_usd?: number;
  ratio?: number;
}

export function assessCredentialBudget(
  lending: Pick<CredentialLendingScope, 'credential_ref' | 'budget_monthly_usd'>,
  tenant: string,
  now: Date,
  options: { history?: CredentialUsageHistory } = {}
): CredentialBudgetAssessment {
  const spent =
    summarizeCredentialUsage(tenant, monthOf(now), options).find(
      (entry) => entry.credential_ref === lending.credential_ref
    )?.est_cost_usd ?? 0;
  const budget = lending.budget_monthly_usd;
  if (budget === undefined) return { status: 'unbounded', spent_usd: spent };
  const ratio = spent / budget;
  return {
    status: ratio >= 1 ? 'exceeded' : ratio >= CREDENTIAL_BUDGET_WARN_RATIO ? 'warn' : 'ok',
    spent_usd: spent,
    budget_usd: budget,
    ratio: Math.round(ratio * 1000) / 1000,
  };
}

/** 100% of the monthly budget: no new run binds this credential until next month or a raise. */
export function assertCredentialBudget(
  lending: Pick<CredentialLendingScope, 'credential_ref' | 'budget_monthly_usd'>,
  tenant: string,
  grantId: string,
  now: Date,
  options: { history?: CredentialUsageHistory } = {}
): CredentialBudgetAssessment {
  const assessment = assessCredentialBudget(lending, tenant, now, options);
  if (assessment.status === 'exceeded')
    throw new Error(
      `[CREDENTIAL_BUDGET_EXCEEDED] ${lending.credential_ref} spent $${assessment.spent_usd.toFixed(2)} of its $${assessment.budget_usd} ${monthOf(now)} budget for tenant ${tenant}; new runs are stopped | next: wait for next month, or re-assign with a larger budget: pnpm kyberion reasoning credentials assign --tenant ${tenant} --credential ${lending.credential_ref} --budget-usd <n> --purpose "<why>" (then revoke ${grantId}) | evidence: pnpm kyberion reasoning credentials usage --tenant ${tenant} --month ${monthOf(now)}`
    );
  return assessment;
}

const BUDGET_CACHE_TTL_MS = 60_000;
const budgetCache = new Map<string, { at: number; assessment: CredentialBudgetAssessment }>();
/** Test seam. */
export function resetCredentialBudgetCache(): void {
  budgetCache.clear();
}

/**
 * Per-use budget stop (review S4): the same check as bind time, against a month
 * total cached for a minute, so a long binding or a resident dot stops at 100%
 * without reading the ledger on every credential consumption.
 */
export function assertCredentialBudgetCached(
  lending: Pick<CredentialLendingScope, 'credential_ref' | 'budget_monthly_usd'>,
  tenant: string,
  grantId: string,
  now: Date,
  options: { history?: CredentialUsageHistory } = {}
): void {
  if (lending.budget_monthly_usd === undefined) return;
  const key = `${tenant}|${lending.credential_ref}|${monthOf(now)}`;
  const cached = budgetCache.get(key);
  if (!cached || now.getTime() - cached.at > BUDGET_CACHE_TTL_MS) {
    budgetCache.set(key, {
      at: now.getTime(),
      assessment: assessCredentialBudget(lending, tenant, now, options),
    });
  }
  if (budgetCache.get(key)!.assessment.status === 'exceeded')
    assertCredentialBudget(lending, tenant, grantId, now, options);
}
