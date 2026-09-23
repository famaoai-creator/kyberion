import * as path from 'node:path';
import { NextResponse } from 'next/server';
import { nowIso } from '@agent/core/foundation';
import { loadPersonalIdentityAtPath } from '@agent/core/personal-identity-reader';
import {
  AVATAR_PROFILE_POINTER,
  loadPersonalAvatarSet,
  personalAvatarDir,
  promotePersonalAvatarDraft,
} from '@agent/core/presence-avatar';
import { resolveActiveProfileRoot } from '@agent/core/profile-root';
import * as secureIo from '@agent/core/secure-io';
import type { ConciergeViewerContext } from '../../../lib/viewer-context';
import {
  readConciergePersonal,
  registeredAvatarPhoto,
  requireConciergeAvatarOwner,
} from '../../../lib/personal-avatar-access';
import {
  AVATAR_PROVIDER_ID_PATTERN,
  runningAvatarGenerationJob,
  startAvatarGenerationJob,
} from '../../../lib/avatar-generation-jobs';
import { optionalSetupObject, requireKnownRequestKeys, type SetupInputObject } from './setup-input';

type Translate = (
  key: 'api.onboarding_input' | 'setup.avatar_generate_needs_photo' | 'setup.avatar_generate_busy'
) => string;

/**
 * PA-10 `POST /api/setup` `action: 'avatar_generate'` — body
 * `{ consent: { provider_id, confirmed: true } }`. The consent dialog named
 * `provider_id`; confirming it is the explicit per-run consent. The server
 * binds it to the resolved owner principal and starts an async job.
 */
export function startAvatarGenerateAction(
  body: SetupInputObject,
  viewer: ConciergeViewerContext,
  t: Translate
): NextResponse {
  const denied = requireConciergeAvatarOwner(viewer);
  if (denied) return denied;
  const consent = optionalSetupObject(body, 'consent');
  if (!consent) {
    return NextResponse.json({ ok: false, error: t('api.onboarding_input') }, { status: 400 });
  }
  requireKnownRequestKeys(consent, ['provider_id', 'confirmed'], 'consent');
  const providerId = consent.provider_id;
  if (
    consent.confirmed !== true ||
    typeof providerId !== 'string' ||
    !AVATAR_PROVIDER_ID_PATTERN.test(providerId)
  ) {
    return NextResponse.json({ ok: false, error: t('api.onboarding_input') }, { status: 400 });
  }
  const running = runningAvatarGenerationJob();
  if (running) {
    return NextResponse.json(
      { ok: false, error: t('setup.avatar_generate_busy'), job: running },
      { status: 409 }
    );
  }
  const profileRoot = resolveActiveProfileRoot();
  const photo = readConciergePersonal(() => registeredAvatarPhoto(profileRoot));
  if (!photo) {
    return NextResponse.json(
      { ok: false, error: t('setup.avatar_generate_needs_photo') },
      { status: 409 }
    );
  }
  const job = startAvatarGenerationJob({
    photoPath: photo,
    // Into `avatar/draft/`: the set in use stays until "Use this avatar".
    outputDir: personalAvatarDir(profileRoot, 'draft'),
    providerId,
    grantedBy: viewer.principalId || 'human:concierge-localadmin',
  });
  return NextResponse.json({ ok: true, job }, { status: 202 });
}

/**
 * PA-10 `action: 'avatar_use'` — adopt the generated set: promote a pending
 * `avatar/draft/` over `avatar/` (the previous set stays until now), then
 * point `identity.avatar_profile` at it. Without a draft, an existing
 * not-yet-adopted `avatar/` set is adopted as is.
 */
export function useGeneratedAvatarAction(
  viewer: ConciergeViewerContext,
  t: Translate
): NextResponse {
  const denied = requireConciergeAvatarOwner(viewer);
  if (denied) return denied;
  const profileRoot = resolveActiveProfileRoot();
  const adopted = readConciergePersonal(() => {
    if (!promotePersonalAvatarDraft(profileRoot) && !loadPersonalAvatarSet(profileRoot)) {
      return false;
    }
    const identityPath = path.join(profileRoot, 'my-identity.json');
    const safeIdentityPath = secureIo.assertSafeRepositoryPath(identityPath, {
      allowMissingLeaf: true,
    });
    const identity = secureIo.safeExistsSync(safeIdentityPath)
      ? loadPersonalIdentityAtPath(safeIdentityPath) || {}
      : { name: 'user', language: 'ja', interaction_style: 'Concierge' };
    identity.avatar_profile = AVATAR_PROFILE_POINTER;
    identity.updated_at = nowIso();
    secureIo.safeWriteFile(safeIdentityPath, JSON.stringify(identity, null, 2), {
      encoding: 'utf8',
    });
    return true;
  });
  if (!adopted) {
    return NextResponse.json(
      { ok: false, error: t('setup.avatar_generate_needs_photo') },
      { status: 409 }
    );
  }
  return NextResponse.json({ ok: true, avatar_profile: AVATAR_PROFILE_POINTER });
}
