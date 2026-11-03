import { NextRequest, NextResponse } from 'next/server';
import {
  hasSurfaceOperation,
  invokeSurfaceOperation,
  listSurfaceOperations,
  surfaceOperationInputFromQuery,
} from '@agent/core/surface/surface-operation-registry';
import {
  resolveConciergeViewer,
  toSurfaceAuthorizationContext,
} from '../../../../lib/viewer-context';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'private, no-store' };

/**
 * The shared surface API: `/api/v1/<domain>/<verb>` → operation `<domain>.<verb>`
 * from libs/core/surface/surface-operation-registry.ts. The same operations
 * are MCP tools (`kyberion.<domain>.<verb>`). `/api/v1/operations` lists them.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ operation: string[] }> }) {
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;
  const segments = (await ctx.params).operation ?? [];
  if (segments.length === 1 && segments[0] === 'operations') {
    return NextResponse.json(
      { ok: true, operations: listSurfaceOperations() },
      { headers: NO_STORE }
    );
  }
  const id = segments.join('.');
  if (segments.length !== 2 || !hasSurfaceOperation(id)) {
    return NextResponse.json(
      { ok: false, error_code: 'unknown_operation', error: `Unknown operation ${id || '(none)'}.` },
      { status: 404, headers: NO_STORE }
    );
  }
  const result = invokeSurfaceOperation(
    id,
    surfaceOperationInputFromQuery(req.nextUrl.searchParams),
    {
      viewer: toSurfaceAuthorizationContext(resolved.context),
    }
  );
  return NextResponse.json(result, { status: result.ok ? 200 : result.status, headers: NO_STORE });
}
