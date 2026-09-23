import { NextRequest, NextResponse } from 'next/server';
import {
  describePersonalAvatar,
  personalAvatarDir,
  type PersonalAvatarSetKind,
} from '@agent/core/presence-avatar';
import { resolveActiveProfileRoot } from '@agent/core/profile-root';
import { conciergeErrorResponse, resolveConciergeViewer } from '../../../../lib/viewer-context';
import {
  CONCIERGE_AVATAR_URL_BASE,
  readConciergePersonal,
  registeredAvatarPhoto,
  requireConciergeAvatarOwner,
} from '../../../../lib/personal-avatar-access';
import {
  getAvatarGenerationJob,
  planAvatarGeneration,
  runningAvatarGenerationJob,
} from '../../../../lib/avatar-generation-jobs';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };
const JOB_ID_PATTERN = /^[0-9a-f-]{36}$/u;

/**
 * PA-10: `GET /api/setup/avatar-generation` — without `job`: the provider a
 * run would send the photo to (for the consent dialog; nothing is sent), the
 * current set, the pending draft (a generation not yet adopted; its frames
 * are served with `?set=draft`) and whether a photo is registered. With
 * `job=<id>`: that job's status (+ the draft it produced). Owner-only.
 */
export async function GET(req: NextRequest) {
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;
  const denied = requireConciergeAvatarOwner(resolved.context);
  if (denied) return denied;
  try {
    const profileRoot = resolveActiveProfileRoot();
    const jobId = req.nextUrl.searchParams.get('job');
    const avatar = (kind: PersonalAvatarSetKind = 'current') =>
      readConciergePersonal(() =>
        describePersonalAvatar(CONCIERGE_AVATAR_URL_BASE, profileRoot, kind)
      );
    if (jobId !== null) {
      const job = JOB_ID_PATTERN.test(jobId) ? getAvatarGenerationJob(jobId) : null;
      if (!job) {
        return NextResponse.json(
          { ok: false, error: 'Unknown avatar job.' },
          { status: 404, headers: NO_STORE }
        );
      }
      return NextResponse.json(
        { ok: true, job, draft: job.status === 'succeeded' ? avatar('draft') : null },
        { headers: NO_STORE }
      );
    }
    const photo = readConciergePersonal(() => registeredAvatarPhoto(profileRoot));
    const plan = photo
      ? await planAvatarGeneration(photo, personalAvatarDir(profileRoot, 'draft'))
      : null;
    return NextResponse.json(
      {
        ok: true,
        photo_available: Boolean(photo),
        plan,
        running_job: runningAvatarGenerationJob(),
        avatar: avatar(),
        draft: avatar('draft'),
      },
      { headers: NO_STORE }
    );
  } catch (error) {
    return conciergeErrorResponse(error, 500);
  }
}
