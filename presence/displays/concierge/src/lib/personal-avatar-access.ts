import * as path from 'node:path';
import { NextResponse } from 'next/server';
import { withExecutionContext } from '@agent/core/authority';
import * as secureIo from '@agent/core/secure-io';
import type { ConciergeViewerContext } from './viewer-context';

/** URL base the concierge serves the user's generated avatar frames from (PA-10). */
export const CONCIERGE_AVATAR_URL_BASE = '/api/me/avatar';

/**
 * PA-10: the generated avatar set is personal-tier data. Concierge viewer
 * scopes never carry `personal`, so — like `/api/setup`, which already reads
 * the profile for the local owner — only the loopback localadmin session may
 * read it. Token viewers (any role) get 403.
 */
export function requireConciergeAvatarOwner(context: ConciergeViewerContext): NextResponse | null {
  if (context.source === 'loopback' && context.role === 'localadmin') return null;
  return NextResponse.json(
    { ok: false, error: 'The personal avatar requires the local owner session.' },
    { status: 403, headers: { 'Cache-Control': 'no-store' } }
  );
}

export function readConciergePersonal<T>(fn: () => T): T {
  return withExecutionContext('sovereign_concierge', () => secureIo.withSensitivePathMediation(fn));
}

/** The registered photo the generator reads (`<profileRoot>/avatar.png`), if present. */
export function registeredAvatarPhoto(profileRoot: string): string | null {
  const photo = path.join(profileRoot, 'avatar.png');
  try {
    const safe = secureIo.assertSafeRepositoryPath(photo, { allowMissingLeaf: true });
    return secureIo.safeExistsSync(safe) && secureIo.safeLstat(safe).isFile() ? safe : null;
  } catch {
    return null;
  }
}
