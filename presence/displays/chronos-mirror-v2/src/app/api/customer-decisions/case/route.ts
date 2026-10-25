import { NextRequest, NextResponse } from 'next/server';
import { guardRequest, requireChronosAccess } from '../../../../lib/api-guard';
import {
  resolveViewerContextForRequest,
  viewerErrorResponse,
  ViewerContextError,
} from '../../../../lib/viewer-context';
import { readChronosOptionalStringParam } from '../../../../lib/request-input';
import {
  customerDecisionNoStore,
  resolveCustomerDecisionTenant,
} from '../../../../lib/customer-decision-viewer-scope';
import { readCustomerDecisionFacade } from '../../../../lib/customer-decision-overview-facade';
import { isCustomerDecisionCaseId } from '../../../../lib/customer-decision-case-response';

/**
 * CD-12 drill-down: one case of one tenant's customer decisions (agenda sets,
 * entries with their question cut to 200 characters, change requests,
 * hand-offs, reminders, invite counts, routing and mission tasks) for the
 * Chronos case and agenda views. The agenda view is a client-side selection
 * of this response. Same viewer scope as the overview
 * (lib/customer-decision-viewer-scope.ts); the data comes from the governed
 * facade child bound to the tenant — never a decision value, rationale,
 * option, comment or participant name.
 */
async function read(req: NextRequest): Promise<Response> {
  const denied = guardRequest(req);
  if (denied) return denied;
  const accessDenied = requireChronosAccess(req, 'readonly');
  if (accessDenied) return accessDenied;

  const resolvedViewer = resolveViewerContextForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;

  try {
    const caseId = readChronosOptionalStringParam(req.nextUrl.searchParams.get('case'));
    const scope = resolveCustomerDecisionTenant(req, resolvedViewer.context);
    if (scope.response) return scope.response;
    if (!caseId || !isCustomerDecisionCaseId(caseId)) {
      return NextResponse.json(
        { error: 'case must be a case id (letters, digits, - and _).' },
        { status: 400 }
      );
    }
    const result = await readCustomerDecisionFacade('case', scope.tenant, caseId);
    if ('error' in result)
      return NextResponse.json(
        { error: result.error, ...(result.reason ? { reason: result.reason } : {}) },
        { status: result.status }
      );
    return NextResponse.json({ case: result.value }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof ViewerContextError) return viewerErrorResponse(error);
    return viewerErrorResponse(error, 500);
  }
}

/** Every answer — data, refusals and errors alike — is `Cache-Control: no-store`. */
export async function GET(req: NextRequest) {
  return customerDecisionNoStore(await read(req));
}
