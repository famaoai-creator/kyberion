import { NextRequest, NextResponse } from 'next/server';
import { recordHumanKnowledgeFeedback } from '@agent/core/src/knowledge-feedback-loop';
import { guardRequest, requireChronosAccess } from '../../../lib/api-guard';
import { readChronosJsonObject } from '../../../lib/request-input';
import { parseKnowledgeFeedbackInput } from './knowledge-feedback-input';
import {
  resolveViewerContextForRequest,
  strictViewerScopeOrganizationIds,
  strictViewerScopeProjectIds,
  strictViewerTier,
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
    const parsedBody = await readChronosJsonObject(req, 'Chronos knowledge feedback');
    if (!parsedBody.ok) return NextResponse.json({ error: parsedBody.error }, { status: 400 });
    let input;
    try {
      input = parseKnowledgeFeedbackInput(parsedBody.body);
    } catch (error) {
      return viewerErrorResponse(error, 400);
    }
    const {
      documentPath,
      verdict,
      tenant: requestedTenant,
      organizationId,
      projectId,
      reason,
    } = input;
    const tenantSlugs = strictViewerScopeTenantSlugs(resolvedViewer.context, requestedTenant);
    const pathParts = documentPath.split('/');
    const tier = strictViewerTier(
      resolvedViewer.context,
      pathParts[1] as 'public' | 'confidential' | 'personal'
    );
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
      organizationId
    );
    const projectIds = strictViewerScopeProjectIds(resolvedViewer.context, projectId);
    const scope = {
      tier,
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
        reason,
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
