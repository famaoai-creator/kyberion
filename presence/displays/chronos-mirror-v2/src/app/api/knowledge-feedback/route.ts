import { NextRequest, NextResponse } from 'next/server';
import { recordHumanKnowledgeFeedback } from '@agent/core';
import { guardRequest, requireChronosAccess } from '../../../lib/api-guard';
import {
  resolveViewerContextForRequest,
  strictViewerScopeOrganizationIds,
  strictViewerScopeProjectIds,
  strictViewerScopeTenantSlugs,
  viewerErrorResponse,
  withViewerExecutionContext,
} from '../../../lib/viewer-context';

export async function POST(req: NextRequest) {
  const denied = guardRequest(req);
  if (denied) return denied;
  const requiresAccess = requireChronosAccess(req, 'readonly');
  if (requiresAccess) return requiresAccess;
  const resolvedViewer = resolveViewerContextForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;
  try {
    const body = (await req.json()) as Record<string, unknown>;
    const documentPath = typeof body.document_path === 'string' ? body.document_path.trim() : '';
    const verdict =
      body.verdict === 'useful' || body.verdict === 'not_useful' ? body.verdict : null;
    if (
      !documentPath ||
      !verdict ||
      !/^knowledge\/(public|confidential|personal)\/.+\.(md|json)$/i.test(documentPath)
    ) {
      return NextResponse.json(
        { error: 'document_path and verdict are required' },
        { status: 400 }
      );
    }
    const requestedTenant = typeof body.tenant === 'string' ? body.tenant : undefined;
    const tenantSlugs = strictViewerScopeTenantSlugs(resolvedViewer.context, requestedTenant);
    const pathParts = documentPath.split('/');
    const pathTenant =
      pathParts[1] === 'confidential' && pathParts[2] !== 'common' ? pathParts[2] : undefined;
    if (pathTenant && tenantSlugs !== 'all' && !tenantSlugs.includes(pathTenant)) {
      return NextResponse.json(
        { error: 'Knowledge document is outside the viewer tenant scope' },
        { status: 403 }
      );
    }
    const organizationIds = strictViewerScopeOrganizationIds(
      resolvedViewer.context,
      typeof body.organization_id === 'string' ? body.organization_id : undefined
    );
    const projectIds = strictViewerScopeProjectIds(
      resolvedViewer.context,
      typeof body.project_id === 'string' ? body.project_id : undefined
    );
    const scope = {
      tier:
        pathParts[1] === 'personal'
          ? 'personal'
          : pathParts[1] === 'confidential'
            ? 'confidential'
            : 'public',
      ...(pathTenant ? { tenant_slug: pathTenant } : {}),
      ...(organizationIds !== 'all' && organizationIds[0]
        ? { organization_id: organizationIds[0] }
        : {}),
      ...(projectIds !== 'all' && projectIds[0] ? { project_id: projectIds[0] } : {}),
    } as const;
    const feedbackPath = withViewerExecutionContext(resolvedViewer.context, () =>
      recordHumanKnowledgeFeedback({
        document_path: documentPath,
        verdict,
        reason: typeof body.reason === 'string' ? body.reason : undefined,
        actor: resolvedViewer.context.principalId || 'chronos-viewer',
        source: 'chronos',
        scope,
      })
    );
    return NextResponse.json({ ok: true, feedback_path: feedbackPath });
  } catch (error) {
    return viewerErrorResponse(error);
  }
}
