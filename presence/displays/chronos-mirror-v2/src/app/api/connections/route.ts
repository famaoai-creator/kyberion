import { NextRequest, NextResponse } from 'next/server';
import {
  getChronosAccessRoleOrThrow,
  guardRequest,
  roleToMissionRole,
} from '../../../lib/api-guard';
import { listConnectionReviewItems, recordConnectionReview } from '../../../lib/connection-review';

export function GET() {
  return NextResponse.json({ connections: listConnectionReviewItems() });
}

export async function POST(req: NextRequest) {
  try {
    const denied = guardRequest(req);
    if (denied) return denied;
    const accessRole = getChronosAccessRoleOrThrow(req);
    process.env.MISSION_ROLE = roleToMissionRole(accessRole);

    const body = await req.json();
    const bindingId = typeof body?.bindingId === 'string' ? body.bindingId : '';
    const action =
      body?.action === 'approve' ||
      body?.action === 'hold' ||
      body?.action === 'delete' ||
      body?.action === 'modify'
        ? body.action
        : null;
    const note = typeof body?.note === 'string' ? body.note : '';
    if (!bindingId || !action) {
      return NextResponse.json({ error: 'Missing connection review payload' }, { status: 400 });
    }

    const review = recordConnectionReview({
      bindingId,
      action,
      note,
      reviewer: 'chronos-localadmin',
      reviewRole: 'mission_controller',
    });

    return NextResponse.json({ ok: true, review });
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || 'Failed to review connection' },
      { status: 500 }
    );
  }
}
