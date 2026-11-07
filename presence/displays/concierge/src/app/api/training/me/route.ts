import { NextRequest, NextResponse } from 'next/server';
import { withExecutionContext } from '@agent/core/authority';
import { nowIso } from '@agent/core/foundation';
import {
  loadTrainingCatalog,
  readTrainingProgress,
  writeTrainingProgress,
  type TrainingStatus,
} from '@agent/core/training-catalog';
import { requireConciergeMutationAccess } from '../../../../lib/api-guard';
import { readRequestObject } from '../../../../lib/request-input';
import { conciergeErrorResponse, resolveConciergeViewer } from '../../../../lib/viewer-context';
import { resolveWorkInventoryMember } from '../../../../lib/work-inventory-member';
import { frontDeskText, resolveConciergeLocale } from '../../../../lib/i18n';

export const dynamic = 'force-dynamic';

/**
 * 使い方 (`/help`): the signed-in member's own training progress. Moved from
 * presence-studio `GET/POST /api/training/progress` (Kyberion server phase 2).
 * Concierge's `/api/training/progress` is the owner's per-member overview, so
 * the viewer's own record lives here.
 *
 * Only ever the server-resolved member: a client-supplied member id is never
 * read. Marking a lesson keeps the studio posture — a localadmin viewer only
 * (studio required a loopback session) — on top of the Concierge mutation
 * gate. The record is `knowledge/personal/members/<id>/training.json`, read and
 * written as `sovereign_concierge`, the role Concierge's other training routes
 * assume (role-assumption-policy); route.test.ts exercises it against the real
 * authority layer.
 */
const TRAINING_ROLE = 'sovereign_concierge';
const STATUSES: readonly TrainingStatus[] = ['not_started', 'in_progress', 'complete'];

function memberNotFound(req: NextRequest) {
  const locale = resolveConciergeLocale(req.headers.get('accept-language') || undefined);
  return NextResponse.json(
    { ok: false, error: frontDeskText('training_member_not_found', locale) },
    { status: 404, headers: { 'Cache-Control': 'no-store' } }
  );
}

export function GET(req: NextRequest) {
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;
  try {
    const member = resolveWorkInventoryMember(resolved.context);
    if (!member) return memberNotFound(req);
    const progress = withExecutionContext(TRAINING_ROLE, () =>
      readTrainingProgress(member.member_id)
    );
    return NextResponse.json({ ok: true, progress }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return conciergeErrorResponse(error, 500);
  }
}

export async function POST(req: NextRequest) {
  const denied = requireConciergeMutationAccess(req);
  if (denied) return denied;
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;
  const locale = resolveConciergeLocale(req.headers.get('accept-language') || undefined);
  if (resolved.context.role !== 'localadmin') {
    return NextResponse.json(
      { ok: false, error: frontDeskText('training_mark_done_local_only', locale) },
      { status: 403 }
    );
  }
  const parsed = await readRequestObject(req, 'request body', ['lesson_id', 'status']);
  if (!parsed.ok) return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });
  try {
    const member = resolveWorkInventoryMember(resolved.context);
    if (!member) return memberNotFound(req);
    const lessonId = typeof parsed.body.lesson_id === 'string' ? parsed.body.lesson_id.trim() : '';
    const status = parsed.body.status as TrainingStatus;
    const known = loadTrainingCatalog()
      .tracks.flatMap((track) => track.lessons)
      .some((lesson) => lesson.id === lessonId);
    if (!known || !STATUSES.includes(status)) {
      return NextResponse.json(
        { ok: false, error: frontDeskText('training_progress_invalid', locale) },
        { status: 400 }
      );
    }
    const progress = withExecutionContext(TRAINING_ROLE, () => {
      const current = readTrainingProgress(member.member_id);
      return writeTrainingProgress({
        ...current,
        lessons: {
          ...current.lessons,
          [lessonId]: { status, ...(status === 'complete' ? { completed_at: nowIso() } : {}) },
        },
      });
    });
    return NextResponse.json({ ok: true, progress }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return conciergeErrorResponse(error, 500);
  }
}
