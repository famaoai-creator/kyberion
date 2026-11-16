/**
 * Monthly usage summary and budget alerts of lent reasoning credentials
 * (design §6), run by the Chronos schedule `pipelines/credential-usage-monthly.json`
 * (`core:credential_usage_monthly`).
 *
 * Per borrower tenant and credential: runs, tokens and the estimated cost of
 * the month, read from the execution-metrics rows the metering funnel stamps
 * (credential-usage-ledger.ts). A lending grant with `budget_monthly_usd`
 * notifies at 80% and at 100% (new runs are then refused at bind time with
 * `[CREDENTIAL_BUDGET_EXCEEDED]`, a classified credential_grant stop).
 * Notifications go through the operator ops_alert channel, once per grant,
 * level and day.
 */
import type { GrantRecord } from '../governance/grant-store.js';
import { notifyOperatorSync } from '../surface/operator-notifications.js';
import {
  assessCredentialBudget,
  monthOf,
  summarizeCredentialUsage,
  type CredentialBudgetAssessment,
  type CredentialUsageHistory,
  type CredentialUsageSummary,
} from './credential-usage-ledger.js';

export interface CredentialBudgetAlert {
  tenant: string;
  grant_id: string;
  credential_ref: string;
  level: 'warn' | 'exceeded';
  assessment: CredentialBudgetAssessment;
}

export interface CredentialUsageMonthlyReport {
  month: string;
  summaries: CredentialUsageSummary[];
  alerts: CredentialBudgetAlert[];
}

const announced = new Set<string>();
/** Test seam: forget what was already announced. */
export function resetCredentialBudgetAlerts(): void {
  announced.clear();
}

export function runCredentialUsageMonthly(input: {
  tenants: readonly string[];
  listAllocations: (tenant: string) => GrantRecord[];
  now?: Date;
  month?: string;
  history?: CredentialUsageHistory;
  notify?: typeof notifyOperatorSync;
}): CredentialUsageMonthlyReport {
  const now = input.now ?? new Date();
  const month = input.month ?? monthOf(now);
  const summaries: CredentialUsageSummary[] = [];
  const alerts: CredentialBudgetAlert[] = [];
  for (const tenant of input.tenants) {
    summaries.push(...summarizeCredentialUsage(tenant, month, { history: input.history }));
    let grants: GrantRecord[] = [];
    try {
      grants = input.listAllocations(tenant);
    } catch {
      continue;
    }
    for (const grant of grants) {
      const lending = grant.scope.credential_lending;
      if (!lending?.budget_monthly_usd || grant.revoked) continue;
      const assessment = assessCredentialBudget(lending, tenant, now, { history: input.history });
      if (assessment.status !== 'warn' && assessment.status !== 'exceeded') continue;
      const level = assessment.status;
      alerts.push({
        tenant,
        grant_id: grant.grant_id,
        credential_ref: lending.credential_ref,
        level,
        assessment,
      });
      const key = `${tenant}:${grant.grant_id}:${level}:${now.toISOString().slice(0, 10)}`;
      if (announced.has(key)) continue;
      announced.add(key);
      const percent = Math.round((assessment.ratio ?? 0) * 100);
      (input.notify ?? notifyOperatorSync)(
        'ops_alert',
        {
          title:
            level === 'exceeded'
              ? `Credential budget reached for ${tenant} — new runs stopped (${lending.credential_ref})`
              : `Credential budget ${percent}% used for ${tenant} (${lending.credential_ref})`,
          body: `${lending.credential_ref} spent $${assessment.spent_usd.toFixed(2)} of $${assessment.budget_usd} in ${month} for tenant ${tenant} (grant ${grant.grant_id}). ${level === 'exceeded' ? 'New runs are refused with [CREDENTIAL_BUDGET_EXCEEDED] until next month or a larger budget.' : 'At 100% new runs stop.'} Details: pnpm kyberion reasoning credentials usage --tenant ${tenant} --month ${month}`,
          correlation_id: `credential-budget:${key}`,
        },
        { scope: { tier: 'confidential', tenant_slug: tenant } }
      );
    }
  }
  return { month, summaries, alerts };
}
