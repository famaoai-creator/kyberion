import { NextResponse, type NextRequest } from 'next/server';
import { resolveTenantDesign } from '@agent/core/tenant-design-resolver';
import { webThemePackToCssVars } from '@agent/core/web-design-system';
import { getRegisteredEnvText } from '@agent/core/foundation';
import { guardRequest } from '../../../lib/api-guard';
import {
  resolveViewerContextForRequest,
  viewerErrorResponse,
  viewerScopeTenantSlugs,
} from '../../../lib/viewer-context';

export async function GET(request: NextRequest) {
  // DS-02 acceptance 4: confidential tenant branding must not be readable
  // by unauthenticated callers — same guard as every other chronos API.
  const denied = guardRequest(request);
  if (denied) return denied;
  const resolvedViewer = resolveViewerContextForRequest(request);
  if (resolvedViewer.response) return resolvedViewer.response;
  const url = new URL(request.url);
  try {
    const requestedCustomer = url.searchParams.get('customerId') || undefined;
    const tenantSlugs = viewerScopeTenantSlugs(resolvedViewer.context, requestedCustomer);
    if (!requestedCustomer && tenantSlugs !== 'all' && tenantSlugs.length !== 1) {
      throw new Error('tenant must be selected for a multi-tenant viewer');
    }
    const customerId = tenantSlugs === 'all' ? undefined : tenantSlugs[0];
    const brandName = url.searchParams.get('brandName') || undefined;
    const designSystemId = url.searchParams.get('designSystemId') || undefined;

    const resolution = resolveTenantDesign({
      rootDir: getRegisteredEnvText('KYBERION_TENANT_DESIGN_ROOT') || undefined,
      customerId,
      brandName,
      designSystemId,
    });

    const cssVars =
      resolution.themePack && typeof resolution.themePack === 'object'
        ? webThemePackToCssVars(resolution.themePack as any)
        : {};

    return NextResponse.json({
      source: resolution.source,
      brand_name: resolution.tokens.brand_name || null,
      css_vars: cssVars,
    });
  } catch (error) {
    return viewerErrorResponse(error);
  }
}
