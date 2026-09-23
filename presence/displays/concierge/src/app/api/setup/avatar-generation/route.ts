import { NextRequest, NextResponse } from 'next/server';
import * as path from 'node:path';
import { describePersonalAvatar, AVATAR_DIRNAME } from '@agent/core/presence-avatar';
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
 * current generated set and whether a photo is registered. With `job=<id>`:
 * that job's status. Owner-only (personal tier).
 */
export async function GET(req: NextRequest) {
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;
  const denied = requireConciergeAvatarOwner(resolved.context);
  if (denied) return denied;
  try {
    const profileRoot = resolveActiveProfileRoot();
    const jobId = req.nextUrl.searchParams.get('job');
    const avatar = () =>
      readConciergePersonal(() => describePersonalAvatar(CONCIERGE_AVATAR_URL_BASE, profileRoot));
    if (jobId !== null) {
      const job = JOB_ID_PATTERN.test(jobId) ? getAvatarGenerationJob(jobId) : null;
      if (!job) {
        return NextResponse.json(
          { ok: false, error: 'Unknown avatar job.' },
          { status: 404, headers: NO_STORE }
        );
      }
      return NextResponse.json(
        { ok: true, job, avatar: job.status === 'succeeded' ? avatar() : null },
        { headers: NO_STORE }
      );
    }
    const photo = readConciergePersonal(() => registeredAvatarPhoto(profileRoot));
    const plan = photo
      ? await planAvatarGeneration(photo, path.join(profileRoot, AVATAR_DIRNAME))
      : null;
    return NextResponse.json(
      {
        ok: true,
        photo_available: Boolean(photo),
        plan,
        running_job: runningAvatarGenerationJob(),
        avatar: avatar(),
      },
      { headers: NO_STORE }
    );
  } catch (error) {
    return conciergeErrorResponse(error, 500);
  }
}
