import { resolveCompany, type CompanyAggregate } from '@agent/core/company';

/** How long a resolved company id is reused. */
export const COMPANY_MEMO_TTL_MS = 60_000;
/** Most tenants remembered at once; the oldest entry goes first. */
export const COMPANY_MEMO_LIMIT = 256;

/** A company whose own records (customer, identity, organization profile) exist. */
function isRecordedCompany(company: CompanyAggregate): boolean {
  return (
    company.customer_ref.exists ||
    company.identity_ref.exists ||
    company.organization_profile_ref.exists
  );
}

/**
 * A short-lived memo of the tenant -> company id lookup the overview route
 * feeds into its organization-scope check. Only the id is kept, never the
 * aggregate, and only for a company that has its own records: a tenant
 * without them (not set up yet) and a lookup that throws are resolved again
 * on the next request, so a newly registered company shows up at once.
 * Authorization is not cached here — the route still narrows the viewer,
 * checks the registry, the tier and the organization scope on every request.
 */
export function createCompanyIdMemo(
  options: {
    resolve?: (tenant: string) => CompanyAggregate;
    ttlMs?: number;
    limit?: number;
    now?: () => number;
  } = {}
) {
  const resolve = options.resolve ?? ((tenant: string) => resolveCompany(tenant));
  const ttl = options.ttlMs ?? COMPANY_MEMO_TTL_MS;
  const limit = options.limit ?? COMPANY_MEMO_LIMIT;
  const now = options.now ?? Date.now;
  const memo = new Map<string, { companyId: string; at: number }>();
  return {
    companyIdOf(tenant: string): string {
      const at = now();
      const hit = memo.get(tenant);
      if (hit && at - hit.at < ttl) return hit.companyId;
      memo.delete(tenant);
      const company = resolve(tenant);
      if (isRecordedCompany(company)) {
        while (memo.size >= limit) {
          const oldest = memo.keys().next().value;
          if (oldest === undefined) break;
          memo.delete(oldest);
        }
        memo.set(tenant, { companyId: company.company_id, at });
      }
      return company.company_id;
    },
    clear(): void {
      memo.clear();
    },
    get size(): number {
      return memo.size;
    },
  };
}

/** The process-wide memo the overview route uses. */
export const companyIdMemo = createCompanyIdMemo();
