import { NextRequest, NextResponse } from 'next/server';
import {
  acceptInboxEntryWithHumanReceipt,
  markInboxEntry,
  type DeliverableInboxStatus,
} from '@agent/core';
import { requireConciergeMutationAccess } from '../../../../lib/api-guard';

export const dynamic = 'force-dynamic';

const ALLOWED_STATUSES: DeliverableInboxStatus[] = [
  'read',
  'accepted',
  'rejected',
  'changes_requested',
];

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const denied = requireConciergeMutationAccess(req);
  if (denied) return denied;

  try {
    const { id } = await context.params;
    const body = await req.json().catch(() => ({}));
    const status = ALLOWED_STATUSES.includes(body?.status)
      ? (body.status as DeliverableInboxStatus)
      : null;
    if (!id || !status) {
      return NextResponse.json(
        { ok: false, error: `id と status (${ALLOWED_STATUSES.join('|')}) が必要です` },
        { status: 400 }
      );
    }
    const updated =
      status === 'accepted'
        ? acceptInboxEntryWithHumanReceipt({
            entryId: id,
            actorId: 'human:concierge',
            authenticated: true,
            authMethod: 'surface_session',
            responsibilityStatement: 'I accept this deliverable on behalf of the operator.',
          })
        : markInboxEntry(id, status, {
            verdictNote: typeof body?.note === 'string' ? body.note : undefined,
            reviewedBy: 'concierge',
          });
    if (!updated) {
      return NextResponse.json(
        { ok: false, error: '該当する成果物が見つかりません' },
        { status: 404 }
      );
    }
    return NextResponse.json({ ok: true, entry: updated });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
