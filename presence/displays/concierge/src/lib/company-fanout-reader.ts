/**
 * The shared per-company fan-out reader behind the personal (all-company)
 * view: `/api/personal-summary` and the personal needs-you queue
 * (`/api/v1/needs-you[/summary]`) both read one full home per company the
 * viewer may select (`companyFanoutViews`).
 *
 * - **Dedicated rate limit.** A fan-out request costs one home read per
 *   company, so it draws from its own per-principal bucket
 *   (`guardCompanyFanoutRateLimit`), never the ordinary Concierge one.
 * - **Short per-viewer cache, invalidated on needs-you mutations.** See
 *   `company-fanout-cache.ts`.
 */
import { NextResponse, type NextRequest } from 'next/server';
import type { CeoSurfaceSummary } from '@agent/core/ceo-surface-summary';
import { readConciergeHome } from './headless-projections';
import { readThroughCompanyFanoutCache } from './company-fanout-cache';
import {
  checkConciergeRateLimit,
  conciergeClientAddress,
  type ConciergeViewerContext,
} from './viewer-context';

export {
  COMPANY_FANOUT_TTL_MS,
  invalidateCompanyFanoutCache,
  withCompanyFanoutInvalidation,
} from './company-fanout-cache';

/** Per-principal fan-out budgets (requests per Concierge rate-limit window). */
export const COMPANY_FANOUT_RATE_LIMITS = {
  /** `/api/personal-summary`: one 20-item home per company. */
  'personal-summary': 20,
  /** `needs-you.list` + `needs-you.summary` (the inbox polls both, the rail badge the summary). */
  'needs-you-personal': 40,
} as const;
export type CompanyFanoutBucket = keyof typeof COMPANY_FANOUT_RATE_LIMITS;

/**
 * The dedicated fan-out rate limit, keyed by the server-resolved principal
 * (else the client address). Returns the 429 response, or null when allowed.
 */
export function guardCompanyFanoutRateLimit(
  req: NextRequest,
  viewer: Pick<ConciergeViewerContext, 'principalId'>,
  bucket: CompanyFanoutBucket,
  headers: Record<string, string> = { 'Cache-Control': 'private, no-store' }
): NextResponse | null {
  const limited = checkConciergeRateLimit(req, {
    limit: COMPANY_FANOUT_RATE_LIMITS[bucket],
    key: `${bucket}:${viewer.principalId ?? conciergeClientAddress(req)}`,
  });
  if (limited.ok) return null;
  return NextResponse.json(
    { ok: false, error_code: 'rate_limited' },
    {
      status: 429,
      headers: {
        ...headers,
        ...(limited.retryAfterSeconds ? { 'Retry-After': String(limited.retryAfterSeconds) } : {}),
      },
    }
  );
}

/** One company's home for the fan-out, reused briefly for the same viewer and scope. */
export function readCompanyFanoutHome(
  viewer: ConciergeViewerContext,
  limit: number,
  now: number = Date.now()
): CeoSurfaceSummary {
  return readThroughCompanyFanoutCache(
    viewer,
    `home:${limit}`,
    () => readConciergeHome(viewer, { limit }),
    now
  );
}
