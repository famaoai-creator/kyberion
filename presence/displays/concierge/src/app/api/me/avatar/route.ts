import { NextRequest, NextResponse } from 'next/server';
import { describePersonalAvatar } from '@agent/core/presence-avatar';
import { conciergeErrorResponse, resolveConciergeViewer } from '../../../../lib/viewer-context';
import {
  CONCIERGE_AVATAR_URL_BASE,
  readConciergePersonal,
  requireConciergeAvatarOwner,
} from '../../../../lib/personal-avatar-access';

export const dynamic = 'force-dynamic';

/**
 * PA-10: `GET /api/me/avatar` — the user's generated set in the
 * `ui:talking-avatar` shape (`images` frame URLs + `mouth` anchor), or
 * `avatar: null` when none exists. Owner-only (personal tier).
 */
export function GET(req: NextRequest) {
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;
  const denied = requireConciergeAvatarOwner(resolved.context);
  if (denied) return denied;
  try {
    const avatar = readConciergePersonal(() => describePersonalAvatar(CONCIERGE_AVATAR_URL_BASE));
    return NextResponse.json({ ok: true, avatar }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return conciergeErrorResponse(error, 500);
  }
}
