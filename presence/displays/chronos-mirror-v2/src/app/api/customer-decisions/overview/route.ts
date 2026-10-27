import { NextRequest, NextResponse } from 'next/server';
import { guardRequest, requireChronosAccess } from '../../../../lib/api-guard';
import {
  resolveViewerContextForRequest,
  viewerErrorResponse,
  ViewerContextError,
} from '../../../../lib/viewer-context';
import {
  customerDecisionNoStore,
  resolveCustomerDecisionTenant,
} from '../../../../lib/customer-decision-viewer-scope';
import { readCustomerDecisionFacade } from '../../../../lib/customer-decision-overview-facade';

/**
 * CD-12: the read-only customer-decision overview of exactly one tenant for
 * the Chronos organization view. The request-derived viewer decides the
 * tenant (lib/customer-decision-viewer-scope.ts); a `tenant` parameter only
 * narrows the viewer's allowed set. The data comes from the governed facade
 * run as a child bound to that tenant — Chronos itself never reads the
 * tenant's decision stores (see lib/customer-decision-overview-facade.ts).
 */
async function read(req: NextRequest): Promise<Response> {
  const denied = guardRequest(req);
  if (denied) return denied;
  const accessDenied = requireChronosAccess(req, 'readonly');
  if (accessDenied) return accessDenied;

  const resolvedViewer = resolveViewerContextForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;

  try {
    const scope = resolveCustomerDecisionTenant(req, resolvedViewer.context);
    if (scope.response) return scope.response;
    const result = await readCustomerDecisionFacade('overview', scope.tenant);
    // `in` narrows the result under this app's non-strict tsconfig as well.
    if ('error' in result)
      return NextResponse.json(
        { error: result.error, ...(result.reason ? { reason: result.reason } : {}) },
        { status: result.status }
      );
    return NextResponse.json(
      { overview: result.value },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    if (error instanceof ViewerContextError) return viewerErrorResponse(error);
    return viewerErrorResponse(error, 500);
  }
}

/** Every answer — data, refusals and errors alike — is `Cache-Control: no-store`. */
export async function GET(req: NextRequest) {
  return customerDecisionNoStore(await read(req));
}
