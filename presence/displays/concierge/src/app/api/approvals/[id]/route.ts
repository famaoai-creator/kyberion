import { NextRequest, NextResponse } from 'next/server';
import { decideApprovalRequest, loadApprovalRequest } from '@agent/core/approval-store';
import { requireConciergeMutationAccess } from '../../../../lib/api-guard';
import { readRequestObject } from '../../../../lib/request-input';
import { conciergeErrorResponse, resolveConciergeViewer } from '../../../../lib/viewer-context';
import { resolveConciergeDecidedBy } from '../../../../lib/front-desk-member';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const denied = requireConciergeMutationAccess(req);
  if (denied) return denied;
  // FD-07: resolving the viewer here is best-effort context for `decided_by`
  // only — an unresolved viewer still falls through to the pre-FD-07
  // 'concierge'/'sovereign' identity below, same as before this change.
  const resolved = resolveConciergeViewer(req);
  const decidedBy = resolved.context ? resolveConciergeDecidedBy(resolved.context) : null;

  try {
    const { id } = await context.params;
    const parsedBody = await readRequestObject(req, 'request body', [
      'decision',
      'channel',
      'storageChannel',
      'reason',
    ]);
    if (!parsedBody.ok)
      return NextResponse.json({ ok: false, error: parsedBody.error }, { status: 400 });
    const { body } = parsedBody;
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
    const record = loadApprovalRequest(storageChannel, id);
    if (!record) {
      return NextResponse.json(
        { ok: false, error: `approval request not found: ${id}` },
        { status: 404 }
      );
    }
    const updated = decideApprovalRequest('sovereign_concierge', {
      channel,
      storageChannel,
      requestId: id,
      decision,
      decidedBy: decidedBy?.id ?? 'concierge',
      decidedByRole: decidedBy?.role ?? 'sovereign',
      authMethod: 'surface_session',
      decidedByType: 'human',
      authenticated: true,
      payloadHash: record.accountability?.payloadHash,
      effectBinding: record.accountability?.effectBinding,
      note:
        typeof body?.reason === 'string' && body.reason.trim()
          ? body.reason.trim()
          : 'Decision captured from the concierge (秘書室) approval queue.',
    });
    return NextResponse.json({ ok: true, approval: updated });
  } catch (error) {
    return conciergeErrorResponse(error, 500);
  }
}
