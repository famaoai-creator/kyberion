import { NextRequest, NextResponse } from 'next/server';
import { withExecutionContext } from '@agent/core/authority';
import { readTenantProfile } from '@agent/core/organization/tenant-registry';
import { throttleCompanyFanout, readCompanyFanoutHome } from '../../../lib/company-fanout-reader';
import { buildPersonalAggregate } from '../../../lib/personal-aggregate';
import { resolveConciergeSelectedViewer } from '../../../lib/selected-tenant';
import { conciergeErrorResponse } from '../../../lib/viewer-context';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };
/** Pending decisions listed per company; the rest stay one company switch away. */
const COMPANY_HOME_LIMIT = 20;

/**
 * The personal (個人) view: a per-company summary of the viewer's allowed
 * companies (plus the company-less card for all-company viewers), with each
 * company's pending decisions read through a viewer narrowed to that company. Served only
 * while the server-resolved selection is personal, so a company view never
 * fetches other companies' counts.
 */
export function GET(req: NextRequest) {
  const resolved = resolveConciergeSelectedViewer(req);
  if (resolved.response) return resolved.response;
  // Each request reads one home per company: the fan-out reader's own bucket.
  const limited = throttleCompanyFanout(req, resolved.viewer, 'personal-summary', NO_STORE);
  if (limited) return limited;
  if (resolved.selection.mode !== 'personal') {
    return NextResponse.json(
      { ok: false, error_code: 'personal_view_required' },
      { status: 409, headers: NO_STORE }
    );
  }
  try {
    const aggregate = buildPersonalAggregate(resolved.viewer, resolved.allowedTenants, {
      readCompanyHome: (companyViewer) => readCompanyFanoutHome(companyViewer, COMPANY_HOME_LIMIT),
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
