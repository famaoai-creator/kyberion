import { NextRequest, NextResponse } from 'next/server';

import { guardOpsRequest, requireOpsAccess } from '../../../../../lib/ops/ops-request-guard';
import {
  resolveOpsViewerForRequest,
  viewerErrorResponse,
  withViewerExecutionContext,
} from '../../../../../lib/ops/ops-viewer';
import { readChronosStringParam } from '../../../../../lib/ops/request-input';
import {
  readMeetingMinutesContent,
  type MinutesSource,
} from '../../../../../lib/ops/meeting-minutes';
import { minutesScopeFromViewer } from '../route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SOURCES: readonly MinutesSource[] = ['mission', 'pad', 'notepad'];

/**
 * One minutes document. `id` is the item id from the list route
 * (`<source>:<key>`); the source's own scope check runs again on read.
 */
export async function GET(req: NextRequest) {
  const denied = guardOpsRequest(req);
  if (denied) return denied;
  const requiresAccess = requireOpsAccess(req, 'readonly');
  if (requiresAccess) return requiresAccess;
  const resolvedViewer = resolveOpsViewerForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;

  const id = readChronosStringParam(req.nextUrl.searchParams.get('id'));
  const separator = id.indexOf(':');
  const source = separator > 0 ? (id.slice(0, separator) as MinutesSource) : undefined;
  const key = separator > 0 ? id.slice(separator + 1) : '';
  if (!source || !SOURCES.includes(source) || !key) {
    return NextResponse.json(
      { ok: false, error: 'id must be <source>:<key> (source: mission|pad|notepad).' },
      { status: 400 }
    );
  }

  let scope;
  try {
    scope = minutesScopeFromViewer(resolvedViewer.context, {});
  } catch (error) {
    return viewerErrorResponse(error);
  }
  const content = withViewerExecutionContext(resolvedViewer.context, () =>
    readMeetingMinutesContent(source, key, scope)
  );
  if (!content) {
    return NextResponse.json({ ok: false, error: 'Minutes not found.' }, { status: 404 });
  }
  return NextResponse.json({ ok: true, minutes: content });
}
