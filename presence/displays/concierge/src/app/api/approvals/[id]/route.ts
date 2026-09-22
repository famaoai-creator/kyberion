import { NextRequest, NextResponse } from 'next/server';
import { decideApprovalRequest, loadApprovalRequest } from '@agent/core/approval-store';
import { requireConciergeMutationAccess } from '../../../../lib/api-guard';
import { readRequestObject } from '../../../../lib/request-input';
import { conciergeErrorResponse, resolveConciergeViewer } from '../../../../lib/viewer-context';
import {
  conciergeDecisionDenied,
  resolveConciergeDecidedBy,
} from '../../../../lib/front-desk-member';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const denied = requireConciergeMutationAccess(req);
  if (denied) return denied;
  // FD-07: a failed viewer resolution is a hard stop — the request never
  // proceeds on the legacy 'concierge'/'sovereign' identity.
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;

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
    // The decision lands on the approval's tenant — the member gate checks
    // the membership for THAT tenant, not the first scope entry (B4/F2).
    const requesterContext = record.requestedByContext as
      { tenant_slug?: string; tenantSlug?: string } | undefined;
    const loopContext = record.work_loop?.context as { tenant_slug?: string } | undefined;
    const resourceTenant =
      requesterContext?.tenant_slug || requesterContext?.tenantSlug || loopContext?.tenant_slug;
    const decisionDenied = conciergeDecisionDenied(resolved.context, resourceTenant);
    if (decisionDenied) return decisionDenied;
    const decidedBy = resolveConciergeDecidedBy(resolved.context, resourceTenant);
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
