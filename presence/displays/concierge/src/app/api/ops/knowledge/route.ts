import {
  resolveChronosWorkspace,
  workspaceSelectionFromSearchParams,
} from '../../../../lib/ops/workspace-scope';
import { projectKnowledgeCandidate } from '../../../../lib/ops/knowledge-candidate-projection';
import { NextRequest, NextResponse } from 'next/server';
import { listMemoryPromotionCandidates } from '@agent/core/knowledge/memory-promotion-queue';
import { guardOpsRequest, requireOpsAccess } from '../../../../lib/ops/ops-request-guard';
import { resolveOpsViewerForRequest, viewerErrorResponse } from '../../../../lib/ops/ops-viewer';
import { memoryCandidateVisibleToViewer } from '../../../../lib/ops/knowledge-scope';
import { withViewerExecutionContext } from '../../../../lib/ops/ops-viewer';

export function GET(req: NextRequest) {
  const denied = guardOpsRequest(req);
  if (denied) return denied;
  const requiresAccess = requireOpsAccess(req, 'readonly');
  if (requiresAccess) return requiresAccess;
  const resolvedViewer = resolveOpsViewerForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;
  try {
    const workspace = resolveChronosWorkspace(
      resolvedViewer.context,
      workspaceSelectionFromSearchParams(req.nextUrl.searchParams)
    );
    const scopedViewer = { ...resolvedViewer.context, ...workspace };
    const tenantSlugs = workspace.tenantSlugs;
    const candidates = withViewerExecutionContext(scopedViewer, () =>
      listMemoryPromotionCandidates()
    )
      .filter((candidate) =>
        memoryCandidateVisibleToViewer(candidate, scopedViewer, workspace.selection.tenant_slug)
      )
      .map(projectKnowledgeCandidate);
    return NextResponse.json({
      ok: true,
      candidates,
      tenantSlugs,
      workspace: workspace.selection,
      ...(workspace.selection.operation_id ? { inheritedScope: 'organization' } : {}),
      accessRole: resolvedViewer.context.role,
    });
  } catch (error) {
    return viewerErrorResponse(error);
  }
}
