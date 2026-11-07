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
 * read. Marking a lesson keeps the studio rule exactly — a loopback localadmin
 * session only (`requirePresenceStudioLocalAdmin`), checked before the shared
 * Concierge mutation gate so a refused person gets this route's own answer.
 * Refusals carry an `error_code` the page maps to its own copy.
 *
 * The record is `knowledge/personal/members/<id>/training.json`, read and
 * written as `sovereign_concierge`, the role Concierge's other training routes
 * assume (role-assumption-policy). Conscious decision: the Concierge viewer's
 * tier mask excludes `personal`, but this is the viewer's own record at a
 * validated, server-resolved member id — not a personal-tier widening for
 * anyone else (same reasoning as work-inventory-member.ts). route.test.ts runs
 * it against the real authority layer under SYSTEM_ROLE=concierge.
 */
const TRAINING_ROLE = 'sovereign_concierge';
const STATUSES: readonly TrainingStatus[] = ['not_started', 'in_progress', 'complete'];

type TrainingRefusal =
  'training_member_not_found' | 'training_mark_done_local_only' | 'training_progress_invalid';

function refuse(req: NextRequest, code: TrainingRefusal, status: 400 | 403 | 404) {
  const locale = resolveConciergeLocale(req.headers.get('accept-language') || undefined);
  return NextResponse.json(
    { ok: false, error: frontDeskText(code, locale), error_code: code },
    { status, headers: { 'Cache-Control': 'no-store' } }
  );
}

export function GET(req: NextRequest) {
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;
  try {
    const member = resolveWorkInventoryMember(resolved.context);
    if (!member) return refuse(req, 'training_member_not_found', 404);
    const progress = withExecutionContext(TRAINING_ROLE, () =>
      readTrainingProgress(member.member_id)
    );
    return NextResponse.json({ ok: true, progress }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return conciergeErrorResponse(error, 500);
  }
}

export async function POST(req: NextRequest) {
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;
  if (resolved.context.source !== 'loopback' || resolved.context.role !== 'localadmin') {
    return refuse(req, 'training_mark_done_local_only', 403);
  }
  const denied = requireConciergeMutationAccess(req);
  if (denied) return denied;
  const parsed = await readRequestObject(req, 'request body', ['lesson_id', 'status']);
  if (!parsed.ok) return refuse(req, 'training_progress_invalid', 400);
  try {
    const member = resolveWorkInventoryMember(resolved.context);
    if (!member) return refuse(req, 'training_member_not_found', 404);
    const lessonId = typeof parsed.body.lesson_id === 'string' ? parsed.body.lesson_id.trim() : '';
    const status = parsed.body.status as TrainingStatus;
    const known = loadTrainingCatalog()
      .tracks.flatMap((track) => track.lessons)
      .some((lesson) => lesson.id === lessonId);
    if (!known || !STATUSES.includes(status)) return refuse(req, 'training_progress_invalid', 400);
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
