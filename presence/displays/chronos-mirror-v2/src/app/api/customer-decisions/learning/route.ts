import { NextRequest, NextResponse } from 'next/server';
import { guardRequest, requireChronosAccess } from '../../../../lib/api-guard';
import {
  resolveViewerContextForRequest,
  viewerErrorResponse,
  ViewerContextError,
} from '../../../../lib/viewer-context';
import { readChronosOptionalStringParam } from '../../../../lib/request-input';
import { resolveCustomerDecisionTenant } from '../../../../lib/customer-decision-viewer-scope';
import { readCustomerDecisionFacade } from '../../../../lib/customer-decision-overview-facade';
import { isLearningReportDate } from '../../../../lib/customer-decision-learning-response';

/**
 * CD-12 drill-down: one tenant's customer-decision learning report as the
 * operator reviews it (counts, subjects, suggestions and their candidate
 * ids; the latest report unless `date=YYYY-MM-DD`). Default values and every
 * option value stay out: a default change only shows as suggested, and the
 * operator decides it with `pnpm organization learning transition`. Same
 * viewer scope as the overview (lib/customer-decision-viewer-scope.ts).
 */
export async function GET(req: NextRequest) {
  const denied = guardRequest(req);
  if (denied) return denied;
  const accessDenied = requireChronosAccess(req, 'readonly');
  if (accessDenied) return accessDenied;

  const resolvedViewer = resolveViewerContextForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;

  try {
    const date = readChronosOptionalStringParam(req.nextUrl.searchParams.get('date'));
    const scope = resolveCustomerDecisionTenant(req, resolvedViewer.context);
    if (scope.response) return scope.response;
    if (date !== undefined && !isLearningReportDate(date)) {
      return NextResponse.json({ error: 'date must be YYYY-MM-DD.' }, { status: 400 });
    }
    const result = await readCustomerDecisionFacade('learning', scope.tenant, date);
    if ('error' in result)
      return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(
      { learning: result.value },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    if (error instanceof ViewerContextError) return viewerErrorResponse(error);
    return viewerErrorResponse(error, 500);
  }
}
