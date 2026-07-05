import { NextRequest, NextResponse } from 'next/server';
import { guardRequest, requireChronosAccess } from '../../../lib/api-guard';
import { reviewDeliverable } from '../../../lib/deliverable-review';

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

    return NextResponse.json({
      ok: true,
      review: result.review,
      state: result.state,
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || 'Failed to review deliverable' },
      { status: 500 }
    );
  }
}
