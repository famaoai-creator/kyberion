/**
 * modeling-actuator — security ledger check plan (external-asset inventory Phase 3).
 *
 * Reads the tenant-scoped external-assets ledger (append-only JSONL under
 * knowledge/confidential/{tenant}/security/) and emits the batch of endpoints
 * an exposure probe should verify: one item per (service, endpoint) pair,
 * carrying the service's identity so results can be recorded back.
 *
 * Layering: this op READS the ledger (read-only, tenant-scoped) — recording
 * check results back is the `security:ledger --record-checks` ceremony, never
 * an op-side write.
 */

import {
  checkStatusFor,
  listSecurityAssets,
  requiredChecksFor,
  type CheckStatus,
  type SecurityLedgerPathOptions,
} from '@agent/core/security-asset-ledger';
import { tenantProfilePath } from '@agent/core/organization/tenant-registry';
import { validateReadPermission } from '@agent/core/tier-guard';

export interface CheckPlanItem {
  service_id: string;
  endpoint: string;
  exposure: string;
  category: string;
}

/** A required check — probeable endpoint check or a manual IPA item. */
export interface CheckObligation {
  service_id: string;
  check_id: string;
  kind: 'probe' | 'manual';
  /** 'done' if fresh, 'stale' if recorded but past re-verification, 'missing'. */
  status: CheckStatus;
}

export interface SecurityCheckPlan {
  kind: 'security_ledger_check_plan';
  tenant: string;
  check_id: string;
  /** Probeable endpoint items for network:exposure_check. */
  items: CheckPlanItem[];
  /** Every required check per service (IPA checklist obligations). */
  obligations: CheckObligation[];
  totals: {
    services: number;
    endpoints: number;
    obligations: number;
    missing: number;
    stale: number;
  };
}

export function securityLedgerCheckPlan(
  tenantSlug: string,
  opts: { includeCategories?: string[]; checkId?: string } & SecurityLedgerPathOptions
): SecurityCheckPlan {
  // Same gate as the CLI (skipped for fixture rootDir, same as the ceremony):
  // the ledger reveals the tenant's security posture.
  if (!opts.rootDir && tenantSlug !== 'common') {
    const decision = validateReadPermission(tenantProfilePath(tenantSlug));
    if (!decision.allowed) {
      throw new Error(
        `[security-check-plan] the current identity cannot read the tenant profile: ${String(
          decision.reason || 'denied'
        )}`
      );
    }
  }
  const checkId = opts.checkId || 'A-1-reachability';
  const include = new Set(opts.includeCategories || ['published-app', 'saas', 'cloud']);
  const items: CheckPlanItem[] = [];
  const obligations: CheckObligation[] = [];
  for (const r of listSecurityAssets(tenantSlug, opts)) {
    if (r.status !== 'active') continue;
    const byCheckId = new Map((r.entry.check_results ?? []).map((c) => [c.check_id, c]));
    const statusOf = (id: string): CheckStatus => checkStatusFor(byCheckId.get(id));
    if (include.has(r.entry.category)) {
      for (const endpoint of r.entry.endpoints) {
        items.push({
          service_id: r.service_id,
          endpoint,
          exposure: r.entry.exposure,
          category: r.entry.category,
        });
      }
    }
    // The probe check itself is an obligation for endpoint-bearing services.
    if (r.entry.endpoints.length > 0) {
      obligations.push({
        service_id: r.service_id,
        check_id: checkId,
        kind: 'probe',
        status: statusOf(checkId),
      });
    }
    // IPA obligations are category-driven and apply to every active entry,
    // including categories the probe scope excludes.
    for (const ipaId of requiredChecksFor(r.entry)) {
      obligations.push({
        service_id: r.service_id,
        check_id: ipaId,
        kind: 'manual',
        status: statusOf(ipaId),
      });
    }
  }
  return {
    kind: 'security_ledger_check_plan',
    tenant: tenantSlug,
    check_id: checkId,
    items,
    obligations,
    totals: {
      services: new Set(items.map((i) => i.service_id)).size,
      endpoints: items.length,
      obligations: obligations.length,
      missing: obligations.filter((o) => o.status === 'missing').length,
      stale: obligations.filter((o) => o.status === 'stale').length,
    },
  };
}
