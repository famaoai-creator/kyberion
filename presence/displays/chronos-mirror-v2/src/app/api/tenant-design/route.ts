import { NextResponse, type NextRequest } from 'next/server';
import { resolveTenantDesign } from '@agent/core/tenant-design-resolver';
import { webThemePackToCssVars } from '@agent/core/web-design-system';
import { guardRequest } from '../../../lib/api-guard';

export async function GET(request: NextRequest) {
  // DS-02 acceptance 4: confidential tenant branding must not be readable
  // by unauthenticated callers — same guard as every other chronos API.
  const denied = guardRequest(request);
  if (denied) return denied;
  const url = new URL(request.url);
  const customerId = url.searchParams.get('customerId') || undefined;
  const brandName = url.searchParams.get('brandName') || undefined;
  const designSystemId = url.searchParams.get('designSystemId') || undefined;

  const resolution = resolveTenantDesign({
    rootDir: process.env.KYBERION_TENANT_DESIGN_ROOT || undefined,
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
}
