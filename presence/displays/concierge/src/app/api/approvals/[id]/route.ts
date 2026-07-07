import { NextRequest, NextResponse } from 'next/server';
import { decideApprovalRequest } from '@agent/core';
import { requireConciergeMutationAccess } from '../../../../lib/api-guard';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const denied = requireConciergeMutationAccess(req);
  if (denied) return denied;

  try {
    const { id } = await context.params;
    const body = await req.json().catch(() => ({}));
    const decision =
      body?.decision === 'approved' || body?.decision === 'rejected' ? body.decision : null;
    const channel = typeof body?.channel === 'string' && body.channel ? body.channel : 'chronos';
    const storageChannel =
      typeof body?.storageChannel === 'string' && body.storageChannel
        ? body.storageChannel
        : channel;
    if (!id || !decision) {
      return NextResponse.json(
        { ok: false, error: 'id と decision (approved|rejected) が必要です' },
        { status: 400 }
      );
    }
    const updated = decideApprovalRequest('sovereign_concierge', {
      channel,
      storageChannel,
      requestId: id,
      decision,
      decidedBy: 'concierge',
      decidedByRole: 'sovereign',
      authMethod: 'surface_session',
      note:
        typeof body?.reason === 'string' && body.reason.trim()
          ? body.reason.trim()
          : 'Decision captured from the concierge (秘書室) approval queue.',
    });
    return NextResponse.json({ ok: true, approval: updated });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
