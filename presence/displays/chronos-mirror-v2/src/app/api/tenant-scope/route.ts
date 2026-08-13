import { NextRequest, NextResponse } from 'next/server';
import { listTenantProfileSlugs, readTenantProfile } from '@agent/core';
import { guardRequest, requireChronosAccess } from '../../../lib/api-guard';
import {
  resolveViewerContextForRequest,
  strictViewerScopeTenantSlugs,
  withViewerExecutionContext,
} from '../../../lib/viewer-context';

export function GET(req: NextRequest) {
  const denied = guardRequest(req);
  if (denied) return denied;
  const requiresAccess = requireChronosAccess(req, 'readonly');
  if (requiresAccess) return requiresAccess;
  const resolvedViewer = resolveViewerContextForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;
  try {
    const requested = req.nextUrl.searchParams.get('tenant') || undefined;
    const tenants = strictViewerScopeTenantSlugs(resolvedViewer.context, requested);
    const visibleSlugs = withViewerExecutionContext(resolvedViewer.context, () =>
      tenants === 'all'
        ? listTenantProfileSlugs()
        : tenants.filter((slug) => listTenantProfileSlugs().includes(slug))
    );
    const options = visibleSlugs
      .map((slug) => {
        const profile = readTenantProfile(slug);
        return profile ? { slug, displayName: profile.display_name, status: profile.status } : null;
      })
      .filter((option): option is { slug: string; displayName: string; status: string } =>
        Boolean(option)
      );
    return NextResponse.json({
      ok: true,
      tenants: options,
      selected: requested || (options.length === 1 ? options[0].slug : null),
      source: resolvedViewer.context.source,
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Tenant scope unavailable' },
      { status: 403 }
    );
  }
}
