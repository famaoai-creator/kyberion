import { frontDeskFetch as fetch } from './front-desk-fetch';
import { decideWithPasskey } from './passkey-client';
import { readApprovalResponseFailure } from './approval-failure';
import type { ConciergeSummary } from './summary-event';

export type ApprovalDecisionItem = Pick<
  ConciergeSummary['approval_queue'][number],
  'id' | 'channel' | 'storage_channel' | 'presented_digest' | 'min_assurance'
>;

/**
 * Sends one approval decision through the tenant-scoped decision route. The
 * server re-resolves the viewer and checks membership in the approval's own
 * tenant on every call — whichever view (company or personal) the card was in.
 * Throws the route's failure so the caller can show it.
 */
export async function postApprovalDecision(
  item: ApprovalDecisionItem,
  decision: 'approved' | 'rejected'
): Promise<void> {
  if (item.min_assurance === 'A3') {
    await decideWithPasskey({
      requestId: item.id,
      decision,
      channel: item.channel,
      storageChannel: item.storage_channel,
      presentedDigest: item.presented_digest,
    });
    return;
  }
  const response = await fetch(`/api/approvals/${encodeURIComponent(item.id)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      decision,
      channel: item.channel,
      storageChannel: item.storage_channel,
      presentedDigest: item.presented_digest,
    }),
  });
  if (!response.ok) throw await readApprovalResponseFailure(response);
}
