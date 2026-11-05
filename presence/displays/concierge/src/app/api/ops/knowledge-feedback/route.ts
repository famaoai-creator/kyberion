import { NextRequest, NextResponse } from 'next/server';
import { recordHumanKnowledgeFeedback } from '@agent/core/knowledge/knowledge-feedback-loop';
import { guardOpsRequest, requireOpsAccess } from '../../../../lib/ops/ops-request-guard';
import { readChronosJsonObject } from '../../../../lib/ops/request-input';
import { parseKnowledgeFeedbackInput } from './knowledge-feedback-input';
import { resolveChronosWorkspace } from '../../../../lib/ops/workspace-scope';
import { knowledgeDocumentVisibleToWorkspace } from '../../../../lib/ops/knowledge-scope';
import {
  resolveOpsViewerForRequest,
  strictViewerTier,
  strictViewerScopeTenantSlugs,
  viewerErrorResponse,
  withViewerExecutionContext,
} from '../../../../lib/ops/ops-viewer';

export async function POST(req: NextRequest) {
  const denied = guardOpsRequest(req);
  if (denied) return denied;
  const requiresAccess = requireOpsAccess(req, 'readonly');
  if (requiresAccess) return requiresAccess;
  const resolvedViewer = resolveOpsViewerForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;
  try {
    const parsedBody = await readChronosJsonObject(req, 'Chronos knowledge feedback');
    if (parsedBody.ok !== true)
      return NextResponse.json({ error: parsedBody.error }, { status: 400 });
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
    const workspace = resolveChronosWorkspace(resolvedViewer.context, {
      tenant_slug: requestedTenant,
      organization_id: organizationId,
      project_id: projectId,
      operation_id: input.operationId,
      tier: input.tier,
    });
    if (!knowledgeDocumentVisibleToWorkspace(documentPath, workspace))
      return NextResponse.json(
        { error: 'Knowledge document is outside the selected workspace' },
        { status: 403 }
      );
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
    const scope = {
      tier,
      ...(pathTenant ? { tenant_slug: pathTenant } : {}),
      ...(workspace.selection.organization_id
        ? { organization_id: workspace.selection.organization_id }
        : {}),
      ...(workspace.selection.project_id ? { project_id: workspace.selection.project_id } : {}),
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
