import { NextRequest, NextResponse } from 'next/server';
import { listMemoryPromotionCandidates } from '@agent/core/memory-promotion-queue';
import { guardRequest, requireChronosAccess } from '../../../lib/api-guard';
import {
  resolveViewerContextForRequest,
  viewerErrorResponse,
  strictViewerScopeTenantSlugs,
} from '../../../lib/viewer-context';
import {
  memoryCandidateVisibleToViewer,
  resolveMemoryCandidateTenant,
} from '../../../lib/knowledge-scope';
import { readChronosOptionalStringParam } from '../../../lib/request-input';

export function GET(req: NextRequest) {
  const denied = guardRequest(req);
  if (denied) return denied;
  const requiresAccess = requireChronosAccess(req, 'readonly');
  if (requiresAccess) return requiresAccess;
  const resolvedViewer = resolveViewerContextForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;
  try {
    const requestedTenant = readChronosOptionalStringParam(req.nextUrl.searchParams.get('tenant'));
    const tenantSlugs = strictViewerScopeTenantSlugs(resolvedViewer.context, requestedTenant);
    const candidates = listMemoryPromotionCandidates()
      .filter((candidate) =>
        memoryCandidateVisibleToViewer(candidate, resolvedViewer.context, requestedTenant)
      )
      .map((candidate) => ({
        ...candidate,
        tenantSlug: resolveMemoryCandidateTenant(candidate),
      }));
    return NextResponse.json({
      ok: true,
      candidates,
      tenantSlugs,
      accessRole: resolvedViewer.context.role,
    });
  } catch (error) {
    return viewerErrorResponse(error);
  }
}
