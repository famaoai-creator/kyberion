import { NextRequest, NextResponse } from 'next/server';
import {
  acceptInboxEntryWithHumanReceipt,
  listInboxEntries,
  markInboxEntry,
  type DeliverableInboxStatus,
} from '@agent/core/deliverable-inbox';
import { withExecutionContext } from '@agent/core/authority';
import { requireConciergeMutationAccess } from '../../../../lib/api-guard';
import { readRequestObject } from '../../../../lib/request-input';
import { conciergeErrorResponse, resolveConciergeViewer } from '../../../../lib/viewer-context';
import {
  conciergeDecisionDenied,
  resolveConciergeDecidedBy,
} from '../../../../lib/front-desk-member';

export const dynamic = 'force-dynamic';

const ALLOWED_STATUSES: DeliverableInboxStatus[] = [
  'read',
  'accepted',
  'rejected',
  'changes_requested',
];

function isAllowedStatus(value: unknown): value is DeliverableInboxStatus {
  return typeof value === 'string' && ALLOWED_STATUSES.includes(value as DeliverableInboxStatus);
}

const ENTRY_NOT_FOUND = '該当する成果物が見つかりません';

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const denied = requireConciergeMutationAccess(req);
  if (denied) return denied;
  // FD-07: a failed viewer resolution is a hard stop — the request never
  // proceeds on the legacy 'human:concierge' / 'concierge' identity.
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;

  try {
    const { id } = await context.params;
    const parsedBody = await readRequestObject(req, 'request body', ['status', 'note']);
    if (!parsedBody.ok)
      return NextResponse.json({ ok: false, error: parsedBody.error }, { status: 400 });
    const { body } = parsedBody;
    const status = isAllowedStatus(body?.status) ? body.status : null;
    if (!id || !status) {
      return NextResponse.json(
        { ok: false, error: `id と status (${ALLOWED_STATUSES.join('|')}) が必要です` },
        { status: 400 }
      );
    }
    // The verdict lands on the entry's tenant — the member gate checks the
    // membership for THAT tenant, not the first scope entry (B4/F2).
    const entry = withExecutionContext('sovereign_concierge', () =>
      listInboxEntries({}).find((item) => item.entry_id === id)
    );
    if (!entry) {
      return NextResponse.json({ ok: false, error: ENTRY_NOT_FOUND }, { status: 404 });
    }
    const decisionDenied = conciergeDecisionDenied(resolved.context, entry.tenant_slug);
    if (decisionDenied) return decisionDenied;
    const decidedBy = resolveConciergeDecidedBy(resolved.context, entry.tenant_slug);
    const updated =
      status === 'accepted'
        ? acceptInboxEntryWithHumanReceipt({
            entryId: id,
            actorId: decidedBy?.id ?? 'human:concierge',
            authenticated: true,
            authMethod: 'surface_session',
            responsibilityStatement: 'I accept this deliverable on behalf of the operator.',
          })
        : markInboxEntry(id, status, {
            verdictNote: typeof body?.note === 'string' ? body.note : undefined,
            reviewedBy: decidedBy?.id ?? 'concierge',
          });
    if (!updated) {
      return NextResponse.json({ ok: false, error: ENTRY_NOT_FOUND }, { status: 404 });
    }
    return NextResponse.json({ ok: true, entry: updated });
  } catch (error) {
    return conciergeErrorResponse(error, 500);
  }
}
