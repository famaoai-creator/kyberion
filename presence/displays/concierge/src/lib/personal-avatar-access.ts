import * as path from 'node:path';
import type { NextResponse } from 'next/server';
import { withExecutionContext } from '@agent/core/authority';
import type { PersonalAvatarSetKind } from '@agent/core/presence-avatar';
import * as secureIo from '@agent/core/secure-io';
import type { ConciergeViewerContext } from './viewer-context';
import {
  installationAccessDenied,
  resolveConciergeInstallationAccess,
} from './installation-access';

/** URL base the concierge serves the user's generated avatar frames from (PA-10). */
export const CONCIERGE_AVATAR_URL_BASE = '/api/me/avatar';

/**
 * PA-10: the generated avatar set is personal-tier data of the installation
 * owner. Concierge viewer scopes never carry `personal`, so — like
 * `/api/setup`, which serves the owner's profile — only the installation
 * owner may read it (installation-access.ts, any transport). Changes go
 * through `POST /api/setup`, which applies the installation write gate.
 * Anyone else gets a stable 401/403 code.
 */
export function requireConciergeAvatarOwner(context: ConciergeViewerContext): NextResponse | null {
  const decision = resolveConciergeInstallationAccess(context, 'read');
  if (decision.allowed) return null;
  return installationAccessDenied(decision);
}

/**
 * The set a request asks for: `?set=draft` (the settings preview of a
 * generation not yet adopted), otherwise the current set.
 */
export function requestedAvatarSet(req: {
  nextUrl?: { searchParams: URLSearchParams };
}): PersonalAvatarSetKind {
  return req.nextUrl?.searchParams.get('set') === 'draft' ? 'draft' : 'current';
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
