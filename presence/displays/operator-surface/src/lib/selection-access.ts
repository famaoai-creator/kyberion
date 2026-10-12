import { NextResponse, type NextRequest } from 'next/server';
import { SurfaceViewerScopeError } from '@agent/core/surface/surface-mutation-guard';
import { isLoopbackRequest } from './peer';
import { resolveOperatorViewer, type OperatorViewer } from './viewer-context';
import { isSelectionAdmin } from './selection-scope';
export {
  isSelectionAdmin,
  isGlobalSelectionAdmin,
  canViewSelectionMission,
  requireSelectionMission,
  SelectionAccessError,
} from './selection-scope';

/** A stricter, selection-only guard; existing unrelated mutation routes are unchanged. */
export function resolveSelectionRequestViewer(req: NextRequest): OperatorViewer | NextResponse {
  try {
    const viewer = resolveOperatorViewer({
      authorization: req.headers.get('authorization'),
      cookie: req.headers.get('cookie'),
      loopback: isLoopbackRequest(req),
    });
    if (req.method !== 'GET') {
      if (!isSelectionAdmin(viewer))
        return NextResponse.json({ error: 'ADMIN_REQUIRED' }, { status: 403 });
      const origin = req.headers.get('origin');
      const site = req.headers.get('sec-fetch-site');
      if (!origin || new URL(origin).origin !== new URL(req.url).origin || site === 'cross-site') {
        return NextResponse.json({ error: 'SAME_ORIGIN_REQUIRED' }, { status: 403 });
      }
    }
    return viewer;
  } catch (error) {
    if (error instanceof SurfaceViewerScopeError)
      return NextResponse.json({ error: 'VIEWER_REQUIRED' }, { status: error.status });
    if (error instanceof TypeError)
      return NextResponse.json({ error: 'SAME_ORIGIN_REQUIRED' }, { status: 403 });
    throw error;
  }
}
