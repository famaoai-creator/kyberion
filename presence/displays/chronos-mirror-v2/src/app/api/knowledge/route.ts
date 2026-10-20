import {
  resolveChronosWorkspace,
  workspaceSelectionFromSearchParams,
} from '../../../lib/workspace-scope';
import { projectKnowledgeCandidate } from '../../../lib/knowledge-candidate-projection';
import { NextRequest, NextResponse } from 'next/server';
import { listMemoryPromotionCandidates } from '@agent/core/knowledge/memory-promotion-queue';
import { guardRequest, requireChronosAccess } from '../../../lib/api-guard';
import { resolveViewerContextForRequest, viewerErrorResponse } from '../../../lib/viewer-context';
import { memoryCandidateVisibleToViewer } from '../../../lib/knowledge-scope';
import { withViewerExecutionContext } from '../../../lib/viewer-context';

export function GET(req: NextRequest) {
  const denied = guardRequest(req);
  if (denied) return denied;
  const requiresAccess = requireChronosAccess(req, 'readonly');
  if (requiresAccess) return requiresAccess;
  const resolvedViewer = resolveViewerContextForRequest(req);
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
