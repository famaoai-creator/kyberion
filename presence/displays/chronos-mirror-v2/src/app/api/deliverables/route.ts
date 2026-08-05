import { NextRequest, NextResponse } from 'next/server';

import { guardRequest, requireChronosAccess } from '../../../lib/api-guard';
import { collectDeliverableInbox } from '../../../lib/deliverable-inbox';
import {
  resolveViewerContextForRequest,
  withViewerExecutionContext,
} from '../../../lib/viewer-context';

export async function GET(req: NextRequest) {
  const denied = guardRequest(req);
  if (denied) return denied;
  const requiresAccess = requireChronosAccess(req, 'readonly');
  if (requiresAccess) return requiresAccess;
  const resolvedViewer = resolveViewerContextForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;

  const limit = Number(req.nextUrl.searchParams.get('limit') || 50);
  const deliverables = withViewerExecutionContext(resolvedViewer.context, () =>
    collectDeliverableInbox({
      query: req.nextUrl.searchParams.get('query') || '',
      missionId: req.nextUrl.searchParams.get('missionId') || '',
      kind: req.nextUrl.searchParams.get('kind') || '',
      tier: (req.nextUrl.searchParams.get('tier') || '') as
        '' | 'personal' | 'confidential' | 'public',
      limit: Number.isFinite(limit) ? limit : 50,
    })
  );

  return NextResponse.json({ deliverables });
}
