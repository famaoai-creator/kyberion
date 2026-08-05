import { NextRequest, NextResponse } from 'next/server';
import { buildOrganizationManagementView } from '@agent/core';
import { resolveCompany } from '@agent/core/company';
import { guardRequest, requireChronosAccess } from '../../../lib/api-guard';
import {
  resolveViewerContextForRequest,
  viewerErrorResponse,
  viewerScopeTenantSlugs,
  withViewerExecutionContext,
  ViewerContextError,
} from '../../../lib/viewer-context';

/**
 * Read-only organization control-plane projection for Chronos Mirror.
 * The tenant is resolved from the server-side active customer context; the
 * browser cannot select an arbitrary tenant through this endpoint. The
 * request-derived viewer still gates access to that active tenant.
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
    const company = resolveCompany();
    // This endpoint has no client-selected tenant parameter. A scoped viewer
    // may read the active organization only when that server-side tenant is
    // within the viewer's grant.
    viewerScopeTenantSlugs(viewer, company.tenant_slug);
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
        name: company.name,
      },
    });
  } catch (error) {
    if (error instanceof ViewerContextError) return viewerErrorResponse(error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to load organization model' },
      { status: 500 }
    );
  }
}
