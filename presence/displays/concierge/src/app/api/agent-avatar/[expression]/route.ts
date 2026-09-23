import { NextRequest, NextResponse } from 'next/server';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';
import { conciergeErrorResponse, resolveConciergeViewer } from '../../../../lib/viewer-context';
import { AGENT_AVATAR_SOURCES } from '../../../../lib/agent-avatar-sources';

export const dynamic = 'force-dynamic';

/** PA-09: `GET /api/agent-avatar/:expression` — see `lib/agent-avatar-sources.ts`. */
export async function GET(req: NextRequest, context: { params: Promise<{ expression: string }> }) {
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;
  try {
    const { expression } = await context.params;
    if (!Object.prototype.hasOwnProperty.call(AGENT_AVATAR_SOURCES, expression)) {
      return NextResponse.json({ ok: false, error: 'Unknown avatar expression.' }, { status: 404 });
    }
    const svg = String(
      safeReadFile(pathResolver.rootResolve(AGENT_AVATAR_SOURCES[expression]), {
        encoding: 'utf8',
      })
    );
    return new NextResponse(svg, {
      status: 200,
      headers: {
        'Content-Type': 'image/svg+xml; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
        // Loaded through <img> only; a direct navigation still cannot run script.
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
      },
    });
  } catch (error) {
    return conciergeErrorResponse(error, 500);
  }
}
