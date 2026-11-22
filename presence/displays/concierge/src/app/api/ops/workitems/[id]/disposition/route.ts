import { NextRequest, NextResponse } from 'next/server';
import {
  applyWorkflowDisposition,
  isWorkflowDisposition,
} from '@agent/core/workforce/workflow-disposition';
import { requireConciergeMutationAccess } from '../../../../../lib/api-guard';
import { readRequestObject } from '../../../../../lib/request-input';
import { conciergeErrorResponse, resolveConciergeViewer } from '../../../../../lib/viewer-context';
import { resolveConciergeDecidedBy } from '../../../../../lib/front-desk-member';

export const dynamic = 'force-dynamic';

/**
 * PB-03: durable workflow disposition for a blocked/review WorkItem.
 * Surfaces never settle disposition through approval-store binary decide.
 */
export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const denied = requireConciergeMutationAccess(req);
  if (denied) return denied;
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;

  try {
    const { id } = await context.params;
    const parsed = await readRequestObject(req, 'request body', [
      'disposition',
      'newOwnerId',
      'note',
      'verificationStep',
    ]);
    if (!parsed.ok) return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });
    const disposition = parsed.body?.disposition;
    if (!id || !isWorkflowDisposition(disposition)) {
      return NextResponse.json(
        { ok: false, error: 'disposition must be retry|skip|reassign|accept' },
        { status: 400 }
      );
    }
    const decidedBy = resolveConciergeDecidedBy(resolved.context);
    const result = applyWorkflowDisposition({
      itemId: id,
      disposition,
      actorId: decidedBy?.id ?? resolved.context.principal?.id ?? 'concierge',
      ...(typeof parsed.body?.newOwnerId === 'string'
        ? { newOwnerId: parsed.body.newOwnerId }
        : {}),
      ...(typeof parsed.body?.note === 'string' ? { note: parsed.body.note } : {}),
      verificationStep: parsed.body?.verificationStep === true,
    });
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    return conciergeErrorResponse(error, 400);
  }
}
