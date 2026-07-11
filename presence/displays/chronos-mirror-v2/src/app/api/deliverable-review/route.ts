import { NextRequest, NextResponse } from 'next/server';
import { acceptInboxEntryWithHumanReceipt, listInboxEntries, markInboxEntry } from '@agent/core';
import { guardRequest, requireChronosAccess } from '../../../lib/api-guard';
import { reviewDeliverable } from '../../../lib/deliverable-review';

const VERDICT_TO_INBOX_STATUS = {
  accept: 'accepted',
  reject: 'rejected',
  'request-changes': 'changes_requested',
} as const;

/**
 * SU-03: keep the shared deliverable inbox (active/shared/inbox/entries.jsonl)
 * in sync with review verdicts so the concierge/operator inbox views reflect
 * the decision without a separate action.
 */
function syncInboxWithVerdict(input: {
  verdict: keyof typeof VERDICT_TO_INBOX_STATUS;
  comment: string;
  missionId?: string;
  artifactPath?: string;
}): number {
  const status = VERDICT_TO_INBOX_STATUS[input.verdict];
  const candidates = listInboxEntries({
    missionId: input.missionId,
    limit: 100,
  }).filter((entry) => {
    if (!input.artifactPath) return Boolean(input.missionId);
    return entry.artifact_paths.some((artifactPath) => artifactPath === input.artifactPath);
  });
  let updated = 0;
  for (const entry of candidates) {
    const updatedEntry =
      status === 'accepted'
        ? acceptInboxEntryWithHumanReceipt({
            entryId: entry.entry_id,
            actorId: 'human:chronos-localadmin',
            authenticated: true,
            authMethod: 'surface_session',
            responsibilityStatement: 'I accept this deliverable on behalf of the operator.',
          })
        : markInboxEntry(entry.entry_id, status, {
            verdictNote: input.comment,
            reviewedBy: 'chronos-localadmin',
          });
    if (updatedEntry) {
      updated += 1;
    }
  }
  return updated;
}

export async function POST(req: NextRequest) {
  try {
    const denied = guardRequest(req);
    if (denied) return denied;
    const requiresAccess = requireChronosAccess(req, 'localadmin');
    if (requiresAccess) return requiresAccess;

    const body = await req.json();
    const artifactId = typeof body?.artifactId === 'string' ? body.artifactId : '';
    const verdict =
      body?.verdict === 'accept' ||
      body?.verdict === 'reject' ||
      body?.verdict === 'request-changes'
        ? body.verdict
        : null;
    const comment = typeof body?.comment === 'string' ? body.comment : '';
    if (!artifactId || !verdict) {
      return NextResponse.json({ error: 'Missing deliverable review payload' }, { status: 400 });
    }

    const result = reviewDeliverable({
      artifactId,
      verdict,
      comment,
      reviewer: 'chronos-localadmin',
      reviewRole: 'mission_controller',
    });

    let inboxUpdated = 0;
    try {
      inboxUpdated = syncInboxWithVerdict({
        verdict,
        comment,
        missionId: result.artifact?.mission_id,
        artifactPath: result.artifact?.path,
      });
    } catch {
      // Inbox sync is best-effort; the review record is the source of truth.
    }

    return NextResponse.json({
      ok: true,
      review: result.review,
      state: result.state,
      inboxUpdated,
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || 'Failed to review deliverable' },
      { status: 500 }
    );
  }
}
