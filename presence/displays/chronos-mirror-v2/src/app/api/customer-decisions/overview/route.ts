import { NextRequest, NextResponse } from 'next/server';
import { listTenantProfileSlugs } from '@agent/core/organization/tenant-registry';
import { resolveCompany } from '@agent/core/company';
import { guardRequest, requireChronosAccess } from '../../../../lib/api-guard';
import {
  resolveViewerContextForRequest,
  strictViewerScopeTenantSlugs,
  strictViewerScopeOrganizationIds,
  strictViewerScopeProjectIds,
  strictViewerTier,
  viewerErrorResponse,
  withViewerExecutionContext,
  ViewerContextError,
} from '../../../../lib/viewer-context';
import { readChronosOptionalStringParam } from '../../../../lib/request-input';
import { readCustomerDecisionOverview } from '../../../../lib/customer-decision-overview-facade';

/**
 * CD-12: the read-only customer-decision overview of exactly one tenant for
 * the Chronos organization view. The request-derived viewer decides the
 * tenant; a `tenant` parameter only narrows the viewer's allowed set (a
 * multi-tenant viewer must name one). The data comes from the governed
 * facade run as a child bound to that tenant — Chronos itself never reads
 * the tenant's decision stores (see lib/customer-decision-overview-facade.ts).
 */
export async function GET(req: NextRequest) {
  const denied = guardRequest(req);
  if (denied) return denied;
  const accessDenied = requireChronosAccess(req, 'readonly');
  if (accessDenied) return accessDenied;

  const resolvedViewer = resolveViewerContextForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;

  try {
    const viewer = resolvedViewer.context;
    // A tenant-wide overview: never for project-limited viewers.
    const requestedProject = readChronosOptionalStringParam(
      req.nextUrl.searchParams.get('project_id')
    );
    if (requestedProject || strictViewerScopeProjectIds(viewer) !== 'all') {
      throw new ViewerContextError(
        403,
        'The customer decision overview is unavailable for project scope.'
      );
    }
    const requestedTenant = readChronosOptionalStringParam(req.nextUrl.searchParams.get('tenant'));
    const tenantSlugs = strictViewerScopeTenantSlugs(viewer, requestedTenant);
    const tenant =
      requestedTenant ||
      (tenantSlugs !== 'all' && tenantSlugs.length === 1 ? tenantSlugs[0] : undefined);
    if (!tenant) {
      return NextResponse.json(
        {
          error:
            'Select one tenant to see its customer decisions (the tenant parameter narrows your scope to one tenant).',
        },
        { status: 400 }
      );
    }
    const registeredTenants = withViewerExecutionContext(viewer, () => listTenantProfileSlugs());
    if (!registeredTenants.includes(tenant)) {
      throw new ViewerContextError(403, `tenant is not registered: ${tenant}`);
    }
    // The child reads the confidential decision stores under its own
    // tenant-bound roles, so the viewer's own reach is checked here: the
    // confidential tier, and the tenant's organization (as the organization
    // model route resolves it). All of this runs before the cached read.
    strictViewerTier(viewer, 'confidential');
    const company = resolveCompany(tenant);
    strictViewerScopeOrganizationIds(viewer, company.company_id);
    const result = await readCustomerDecisionOverview(tenant);
    // `in` narrows the result under this app's non-strict tsconfig as well.
    if ('error' in result)
      return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(
      { overview: result.overview },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    if (error instanceof ViewerContextError) return viewerErrorResponse(error);
    return viewerErrorResponse(error, 500);
  }
}
