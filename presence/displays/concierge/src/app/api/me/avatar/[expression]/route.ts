import { NextRequest, NextResponse } from 'next/server';
import { isAvatarExpression, readPersonalAvatarAsset } from '@agent/core/presence-avatar';
import { conciergeErrorResponse, resolveConciergeViewer } from '../../../../../lib/viewer-context';
import {
  readConciergePersonal,
  requireConciergeAvatarOwner,
} from '../../../../../lib/personal-avatar-access';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * PA-10: `GET /api/me/avatar/:expression` — one frame of the user's generated
 * avatar set (`<profileRoot>/avatar/`). Owner-only, fixed expression
 * allow-list (never a path), sniffed image content type, `no-store`.
 */
export async function GET(req: NextRequest, context: { params: Promise<{ expression: string }> }) {
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;
  const denied = requireConciergeAvatarOwner(resolved.context);
  if (denied) return denied;
  try {
    const { expression } = await context.params;
    if (!isAvatarExpression(expression)) {
      return NextResponse.json(
        { ok: false, error: 'Unknown avatar expression.' },
        { status: 404, headers: NO_STORE }
      );
    }
    const asset = readConciergePersonal(() => readPersonalAvatarAsset(expression));
    if (!asset) {
      return NextResponse.json(
        { ok: false, error: 'Avatar frame not found.' },
        { status: 404, headers: NO_STORE }
      );
    }
    return new NextResponse(new Uint8Array(asset.bytes), {
      status: 200,
      headers: {
        ...NO_STORE,
        'Content-Type': asset.contentType,
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    return conciergeErrorResponse(error, 500);
  }
}
