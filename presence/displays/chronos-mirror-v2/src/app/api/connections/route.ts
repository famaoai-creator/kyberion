import { NextRequest, NextResponse } from 'next/server';
import { guardRequest, requireChronosAccess } from '../../../lib/api-guard';
import { listConnectionReviewItems, recordConnectionReview } from '../../../lib/connection-review';
import {
  resolveViewerContextForRequest,
  strictViewerScopeTenantSlugs,
  viewerErrorResponse,
  withViewerExecutionContext,
} from '../../../lib/viewer-context';

function bindingTenant(binding: { metadata?: Record<string, unknown> }): string | undefined {
  const value = binding.metadata?.tenant_slug ?? binding.metadata?.tenantSlug;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function GET(req: NextRequest) {
  const denied = guardRequest(req);
  if (denied) return denied;
  const requiresAccess = requireChronosAccess(req, 'readonly');
  if (requiresAccess) return requiresAccess;
  const resolvedViewer = resolveViewerContextForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;

  try {
    const tenant = req.nextUrl.searchParams.get('tenant') || undefined;
    const tenantSlugs = strictViewerScopeTenantSlugs(resolvedViewer.context, tenant);
    return withViewerExecutionContext(resolvedViewer.context, () => {
      const connections = listConnectionReviewItems().filter(
        (binding) =>
          tenantSlugs === 'all' ||
          Boolean(bindingTenant(binding) && tenantSlugs.includes(bindingTenant(binding)!))
      );
      return NextResponse.json({ connections, accessRole: resolvedViewer.context.role });
    });
  } catch (error) {
    return viewerErrorResponse(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    const denied = guardRequest(req);
    if (denied) return denied;
    const requiresAccess = requireChronosAccess(req, 'localadmin');
    if (requiresAccess) return requiresAccess;
    const resolvedViewer = resolveViewerContextForRequest(req);
    if (resolvedViewer.response) return resolvedViewer.response;

    const body = await req.json();
    const bindingId = typeof body?.bindingId === 'string' ? body.bindingId : '';
    const action =
      body?.action === 'approve' ||
      body?.action === 'hold' ||
      body?.action === 'delete' ||
      body?.action === 'modify'
        ? body.action
        : null;
    const note = typeof body?.note === 'string' ? body.note : '';
    if (!bindingId || !action) {
      return NextResponse.json({ error: 'Missing connection review payload' }, { status: 400 });
    }
    const tenant = typeof body?.tenant === 'string' ? body.tenant : undefined;
    const tenantSlugs = strictViewerScopeTenantSlugs(resolvedViewer.context, tenant);
    const binding = listConnectionReviewItems().find((item) => item.binding_id === bindingId);
    if (
      !binding ||
      (tenantSlugs !== 'all' &&
        (!bindingTenant(binding) || !tenantSlugs.includes(bindingTenant(binding)!)))
    ) {
      return NextResponse.json(
        { error: 'Connection is outside the viewer tenant scope' },
        { status: 403 }
      );
    }

    const review = withViewerExecutionContext(resolvedViewer.context, () =>
      recordConnectionReview({
        bindingId,
        action,
        note,
        reviewer: 'chronos-localadmin',
        reviewRole: 'mission_controller',
      })
    );

    return NextResponse.json({ ok: true, review });
  } catch (err: any) {
    if (
      err instanceof Error &&
      /viewer tenant scope|invalid viewer tenant scope/u.test(err.message)
    ) {
      return viewerErrorResponse(err, 403);
    }
    return viewerErrorResponse(err, 500);
  }
}
