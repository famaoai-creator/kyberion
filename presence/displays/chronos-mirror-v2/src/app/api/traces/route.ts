import { NextRequest, NextResponse } from 'next/server';

import { guardRequest, requireChronosAccess } from '../../../lib/api-guard';
import {
  collectTraceDetail,
  collectTraceFeed,
  resolveTraceFeedDirs,
} from '../../../lib/trace-feed';
import {
  resolveViewerContextForRequest,
  strictViewerScopeOrganizationIds,
  strictViewerScopeProjectIds,
  viewerErrorResponse,
  withViewerExecutionContext,
} from '../../../lib/viewer-context';
import { readChronosOptionalStringParam, readChronosStringParam } from '../../../lib/request-input';

export async function GET(req: NextRequest) {
  const denied = guardRequest(req);
  if (denied) return denied;

  const requiresAccess = requireChronosAccess(req, 'readonly');
  if (requiresAccess) return requiresAccess;
  const resolvedViewer = resolveViewerContextForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;

  const limit = Number(readChronosStringParam(req.nextUrl.searchParams.get('limit')) || 24);
  const status = readChronosStringParam(req.nextUrl.searchParams.get('status'));
  const missionId = readChronosStringParam(req.nextUrl.searchParams.get('missionId'));
  const pipelineId = readChronosStringParam(req.nextUrl.searchParams.get('pipelineId'));
  const actuator = readChronosStringParam(req.nextUrl.searchParams.get('actuator'));
  const query = readChronosStringParam(req.nextUrl.searchParams.get('query'));
  const traceId = readChronosStringParam(req.nextUrl.searchParams.get('traceId'));
  let organizationIds: ReturnType<typeof strictViewerScopeOrganizationIds>;
  let projectIds: ReturnType<typeof strictViewerScopeProjectIds>;
  try {
    organizationIds = strictViewerScopeOrganizationIds(
      resolvedViewer.context,
      readChronosOptionalStringParam(req.nextUrl.searchParams.get('organization_id'))
    );
    projectIds = strictViewerScopeProjectIds(
      resolvedViewer.context,
      readChronosOptionalStringParam(req.nextUrl.searchParams.get('project_id'))
    );
  } catch (error) {
    return viewerErrorResponse(error);
  }
  return withViewerExecutionContext(resolvedViewer.context, () => {
    if (traceId) {
      const trace = collectTraceDetail(traceId, {
        strictUnknownSpans: true,
        limit: Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.floor(limit))) : 24,
        tenantSlugs: resolvedViewer.context.tenantSlugs,
        tierAccess: resolvedViewer.context.tierAccess ?? ['public', 'confidential'],
        organizationIds,
        projectIds,
      });

      return NextResponse.json({
        trace,
        traceDir: resolveTraceFeedDirs()[0] || 'active/shared/logs/traces',
      });
    }

    const traces = collectTraceFeed({
      strictUnknownSpans: true,
      limit: Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.floor(limit))) : 24,
      status:
        status === 'ok' || status === 'error' || status === 'in_progress' ? status : undefined,
      missionId: missionId || undefined,
      pipelineId: pipelineId || undefined,
      actuator: actuator || undefined,
      query: query || undefined,
      tenantSlugs: resolvedViewer.context.tenantSlugs,
      tierAccess: resolvedViewer.context.tierAccess ?? ['public', 'confidential'],
      organizationIds,
      projectIds,
    });

    return NextResponse.json({
      traces,
      traceDir: resolveTraceFeedDirs()[0] || 'active/shared/logs/traces',
    });
  });
}
