import { NextRequest, NextResponse } from 'next/server';
import { withExecutionContext } from '@agent/core/authority';
import { readTenantProfile } from '@agent/core/organization/tenant-registry';
import { readConciergeHome } from '../../../lib/headless-projections';
import { buildPersonalAggregate } from '../../../lib/personal-aggregate';
import { resolveConciergeSelectedViewer } from '../../../lib/selected-tenant';
import {
  checkConciergeRateLimit,
  conciergeClientAddress,
  conciergeErrorResponse,
} from '../../../lib/viewer-context';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };
const COMPANY_HOME_LIMIT = 5;
/** Each request reads one home per company, so it gets its own, smaller bucket. */
const PERSONAL_SUMMARY_RATE_LIMIT = 20;

/**
 * The personal (個人) view: a per-company summary of the viewer's allowed
 * companies (plus the company-less card for all-company viewers). Served only
 * while the server-resolved selection is personal, so a company view never
 * fetches other companies' counts.
 */
export function GET(req: NextRequest) {
  const resolved = resolveConciergeSelectedViewer(req);
  if (resolved.response) return resolved.response;
  const limited = checkConciergeRateLimit(req, {
    limit: PERSONAL_SUMMARY_RATE_LIMIT,
    key: `personal-summary:${resolved.viewer.principalId ?? conciergeClientAddress(req)}`,
  });
  if (!limited.ok) {
    return NextResponse.json(
      { ok: false, error_code: 'rate_limited' },
      {
        status: 429,
        headers: {
          ...NO_STORE,
          ...(limited.retryAfterSeconds
            ? { 'Retry-After': String(limited.retryAfterSeconds) }
            : {}),
        },
      }
    );
  }
  if (resolved.selection.mode !== 'personal') {
    return NextResponse.json(
      { ok: false, error_code: 'personal_view_required' },
      { status: 409, headers: NO_STORE }
    );
  }
  try {
    const aggregate = buildPersonalAggregate(resolved.viewer, resolved.allowedTenants, {
      readCompanyHome: (companyViewer) =>
        readConciergeHome(companyViewer, { limit: COMPANY_HOME_LIMIT }),
      displayName: (slug) =>
        withExecutionContext(
          'sovereign_concierge',
          () => readTenantProfile(slug)?.display_name ?? null
        ),
    });
    return NextResponse.json({ ok: true, ...aggregate }, { headers: NO_STORE });
  } catch (error) {
    return conciergeErrorResponse(error);
  }
}
