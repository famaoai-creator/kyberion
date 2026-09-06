import { NextRequest, NextResponse } from 'next/server';
import { buildOrganizationManagementView } from '@agent/core/organization-operating-model-management';
import { listTenantProfileSlugs } from '@agent/core/tenant-registry';
import { resolveCompany } from '@agent/core/company';
import { guardRequest, requireChronosAccess } from '../../../lib/api-guard';
import {
  resolveViewerContextForRequest,
  strictViewerScopeTenantSlugs,
  viewerErrorResponse,
  withViewerExecutionContext,
  ViewerContextError,
} from '../../../lib/viewer-context';
import { readChronosOptionalStringParam } from '../../../lib/request-input';

/**
 * Read-only organization control-plane projection for Chronos Mirror.
 * The browser may narrow the organization view to a tenant, but the
 * request-derived viewer remains the authority for whether that tenant can be
 * read. When no tenant is selected, preserve the active customer for the
 * all-tenant operator view and use the sole granted tenant for scoped viewers.
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
    const requestedTenant = readChronosOptionalStringParam(req.nextUrl.searchParams.get('tenant'));
    const tenantSlugs = strictViewerScopeTenantSlugs(viewer, requestedTenant);
    const selectedTenant =
      requestedTenant ||
      (tenantSlugs !== 'all' && tenantSlugs.length === 1 ? tenantSlugs[0] : undefined);
    const registeredTenants = withViewerExecutionContext(viewer, () => listTenantProfileSlugs());
    if (selectedTenant && !registeredTenants.includes(selectedTenant)) {
      throw new ViewerContextError(403, `tenant is not registered: ${selectedTenant}`);
    }
    const company = resolveCompany(selectedTenant);
    const view = withViewerExecutionContext(viewer, () =>
      buildOrganizationManagementView({
        organizationId: company.company_id,
        tier: 'confidential',
        tenantSlug: company.tenant_slug,
      })
    );
    return NextResponse.json({
      view,
      tenant: {
        company_id: company.company_id,
        tenant_slug: company.tenant_slug,
        name: view.purpose?.name || view.operational_state?.name || company.name,
      },
    });
  } catch (error) {
    if (error instanceof ViewerContextError) return viewerErrorResponse(error);
    return viewerErrorResponse(error, 500);
  }
}
