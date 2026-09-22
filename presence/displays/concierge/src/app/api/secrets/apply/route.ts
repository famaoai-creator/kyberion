import { NextRequest, NextResponse } from 'next/server';
import { applySecretIntroduction } from '@agent/core/secret-introduction';
import { requireConciergeMutationAccess } from '../../../../lib/api-guard';
import { readRequestObject } from '../../../../lib/request-input';
import { conciergeErrorResponse, resolveConciergeViewer } from '../../../../lib/viewer-context';
import {
  conciergeDecisionDenied,
  resolveConciergeDecidedBy,
} from '../../../../lib/front-desk-member';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const denied = requireConciergeMutationAccess(req);
  if (denied) return denied;
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;
  const decisionDenied = conciergeDecisionDenied(resolved.context);
  if (decisionDenied) return decisionDenied;
  const decidedBy = resolveConciergeDecidedBy(resolved.context);

  try {
    const parsedBody = await readRequestObject(req, 'request body', [
      'approvalId',
      'value',
      'channel',
      'storageChannel',
    ]);
    if (!parsedBody.ok) {
      return NextResponse.json({ ok: false, error: parsedBody.error }, { status: 400 });
    }
    const { body } = parsedBody;
    const approvalId = typeof body.approvalId === 'string' ? body.approvalId.trim() : '';
    const value = typeof body.value === 'string' ? body.value : '';
    if (!approvalId || !value) {
      return NextResponse.json(
        { ok: false, error: 'approvalId and value are required' },
        { status: 400 }
      );
    }

    try {
      const applied = await applySecretIntroduction({
        approvalId,
        value,
        channel: typeof body.channel === 'string' ? body.channel : 'concierge',
        storageChannel: typeof body.storageChannel === 'string' ? body.storageChannel : 'concierge',
        appliedBy: decidedBy?.id ?? 'concierge',
      });

      return NextResponse.json({
        ok: true,
        approvalId: applied.approvalId,
        status: applied.status,
        envName: applied.identity.envName,
        changedKeys: applied.changedKeys,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/must be approved/i.test(message)) {
        return NextResponse.json({ ok: false, error: message }, { status: 403 });
      }
      throw error;
    }
  } catch (error) {
    return conciergeErrorResponse(error, 500);
  }
}
