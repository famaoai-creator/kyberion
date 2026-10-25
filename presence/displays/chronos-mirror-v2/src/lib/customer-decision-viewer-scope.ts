import { NextResponse, type NextRequest } from 'next/server';
import { listTenantProfileSlugs } from '@agent/core/organization/tenant-registry';
import {
  strictViewerScopeOrganizationIds,
  strictViewerScopeProjectIds,
  strictViewerScopeTenantSlugs,
  strictViewerTier,
  withViewerExecutionContext,
  ViewerContextError,
  type ViewerContext,
} from './viewer-context';
import { readChronosOptionalStringParam } from './request-input';

/**
 * CD-12: the one tenant a customer-decision read (overview, case detail,
 * learning view) may cover, resolved from the request-derived viewer. A
 * `tenant` parameter only narrows the viewer's allowed set (a multi-tenant
 * viewer must name one); it never widens it.
 *
 * Checks, in order, all before any facade child runs (and before its cache):
 * project scope is refused (these views are tenant-wide), the tenant is in the
 * viewer's scope, the tenant is registered, the viewer reaches the
 * confidential tier, and the viewer reaches the tenant's organization.
 *
 * Returns the tenant, or a 400 response when the viewer must pick one tenant.
 * Scope refusals throw {@link ViewerContextError} (the route maps them with
 * `viewerErrorResponse`).
 */
export function resolveCustomerDecisionTenant(
  req: NextRequest,
  viewer: ViewerContext
): { tenant: string; response?: undefined } | { tenant?: undefined; response: NextResponse } {
  // A tenant-wide view: never for project-limited viewers.
  const requestedProject = readChronosOptionalStringParam(
    req.nextUrl.searchParams.get('project_id')
  );
  if (requestedProject || strictViewerScopeProjectIds(viewer) !== 'all') {
    throw new ViewerContextError(403, 'Customer decisions are unavailable for project scope.');
  }
  const requestedTenant = readChronosOptionalStringParam(req.nextUrl.searchParams.get('tenant'));
  const tenantSlugs = strictViewerScopeTenantSlugs(viewer, requestedTenant);
  const tenant =
    requestedTenant ||
    (tenantSlugs !== 'all' && tenantSlugs.length === 1 ? tenantSlugs[0] : undefined);
  if (!tenant) {
    return {
      response: NextResponse.json(
        {
          error:
            'Select one tenant to see its customer decisions (the tenant parameter narrows your scope to one tenant).',
        },
        { status: 400 }
      ),
    };
  }
  const registeredTenants = withViewerExecutionContext(viewer, () => listTenantProfileSlugs());
  if (!registeredTenants.includes(tenant)) {
    throw new ViewerContextError(403, `tenant is not registered: ${tenant}`);
  }
  // The child reads the confidential decision stores under its own
  // tenant-bound roles, so the viewer's own reach is checked here: the
  // confidential tier, and the tenant's organization (as the organization
  // model route resolves it).
  strictViewerTier(viewer, 'confidential');
  // A tenant's organization id is its slug: `resolveCompany` sets
  // `company_id` to the tenant slug (libs/core/company.ts), so the whole
  // company aggregate is not loaded just to read it back.
  strictViewerScopeOrganizationIds(viewer, tenant);
  return { tenant };
}
