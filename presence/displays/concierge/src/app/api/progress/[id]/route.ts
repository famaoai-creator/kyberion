import { NextRequest, NextResponse } from 'next/server';
import {
  PROGRESS_NO_STORE,
  progressItemUnavailable,
  progressReadFailed,
  resolveProgressScope,
} from '../../../../lib/progress-request';
import { readProgressDetail } from '../../../../lib/progress-server';
import { conciergeErrorResponse } from '../../../../lib/viewer-context';

export const dynamic = 'force-dynamic';

/** Exact (decoded) task-session or artifact id: bounded, no control characters. */
// eslint-disable-next-line no-control-regex
const ITEM_ID = /^[^\u0000-\u001f\u007f]{1,256}$/u;

/**
 * Detail and history of one request (`[id]` is a task-session id or an
 * artifact-record id). Moved from presence-studio `GET /api/progress/:id`.
 * An unknown id and an id outside the viewer's scope get the same coded 404.
 */
export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  let resolved: ReturnType<typeof resolveProgressScope>;
  try {
    resolved = resolveProgressScope(req);
  } catch (error) {
    return conciergeErrorResponse(error);
  }
  if (resolved.response) return resolved.response;
  const itemId = typeof id === 'string' ? id : '';
  if (!ITEM_ID.test(itemId)) return progressItemUnavailable(req);
  try {
    const item = readProgressDetail(resolved.scope, itemId);
    if (!item) return progressItemUnavailable(req);
    return NextResponse.json({ ok: true, item }, { headers: PROGRESS_NO_STORE });
  } catch (error) {
    return progressReadFailed('GET /api/progress/[id]', error);
  }
}
