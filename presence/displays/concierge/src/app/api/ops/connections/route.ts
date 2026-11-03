import { NextRequest, NextResponse } from 'next/server';
import { guardOpsRequest, requireOpsAccess } from '../../../../lib/ops/ops-request-guard';
import {
  listConnectionReviewItems,
  recordConnectionReview,
} from '../../../../lib/ops/connection-review';
import {
  readChronosJsonObject,
  readChronosOptionalStringParam,
} from '../../../../lib/ops/request-input';
import { parseConnectionReviewInput } from './connection-review-input';
import {
  resolveOpsViewerForRequest,
  strictViewerScopeTenantSlugs,
  viewerErrorResponse,
  withViewerExecutionContext,
} from '../../../../lib/ops/ops-viewer';

function bindingTenant(binding: { metadata?: Record<string, unknown> }): string | undefined {
  const value = binding.metadata?.tenant_slug ?? binding.metadata?.tenantSlug;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function GET(req: NextRequest) {
  const denied = guardOpsRequest(req);
  if (denied) return denied;
  const requiresAccess = requireOpsAccess(req, 'readonly');
  if (requiresAccess) return requiresAccess;
  const resolvedViewer = resolveOpsViewerForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;

  try {
    const tenant = readChronosOptionalStringParam(req.nextUrl.searchParams.get('tenant'));
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
    const denied = guardOpsRequest(req);
    if (denied) return denied;
    const requiresAccess = requireOpsAccess(req, 'localadmin');
    if (requiresAccess) return requiresAccess;
    const resolvedViewer = resolveOpsViewerForRequest(req);
    if (resolvedViewer.response) return resolvedViewer.response;

    const parsedBody = await readChronosJsonObject(req, 'Chronos connections');
    if (parsedBody.ok !== true)
      return NextResponse.json({ error: parsedBody.error }, { status: 400 });
    let input;
    try {
      input = parseConnectionReviewInput(parsedBody.body);
    } catch (error) {
      return viewerErrorResponse(error, 400);
    }
    const { bindingId, action, note, tenant } = input;
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
