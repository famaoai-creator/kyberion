import { frontDeskFetch as fetch } from './front-desk-fetch';
import { withPageProjectScope } from './project-selection';
import { decideWithPasskey } from './passkey-client';
import { readApprovalResponseFailure } from './approval-failure';
import { parseConciergeMutationResponse } from './mutation-response';
import type {
  NeedsYouItem,
  NeedsYouPage,
  NeedsYouReason,
  NeedsYouSummary,
} from '@agent/core/surface/needs-you';

/**
 * Browser side of the needs-you queue (`/inbox`). Reads come from
 * `/api/v1/needs-you`; each kind has exactly one write helper here, and each
 * helper calls that kind's existing governed endpoint — the server re-resolves
 * the viewer and checks scope on every call. Nothing here decides anything on
 * its own; every helper runs only from an explicit click.
 */

export type { NeedsYouItem, NeedsYouPage, NeedsYouReason, NeedsYouSummary };

/** Same order as `NEEDS_YOU_REASONS` in core (kept local: core's module is server-shaped). */
export const INBOX_REASONS: readonly NeedsYouReason[] = [
  'approval',
  'decision',
  'review',
  'knowledge',
  'clarification',
  'failure',
];

export interface InboxFilters {
  reason?: NeedsYouReason;
  overdue: boolean;
}

/** URL → filters. Unknown values are ignored, never passed through. */
export function parseInboxFilters(params: Pick<URLSearchParams, 'get'>): InboxFilters {
  const reason = params.get('reason');
  const overdue = params.get('overdue');
  return {
    ...(reason && (INBOX_REASONS as readonly string[]).includes(reason)
      ? { reason: reason as NeedsYouReason }
      : {}),
    overdue: overdue === '1' || overdue === 'true',
  };
}

/** Filters → `/inbox?…`, keeping any other query (the shell's scope) intact. */
export function inboxHref(filters: InboxFilters, keep?: Pick<URLSearchParams, 'toString'>): string {
  const params = new URLSearchParams(keep?.toString() ?? '');
  params.delete('reason');
  params.delete('overdue');
  params.delete('cursor');
  if (filters.reason) params.set('reason', filters.reason);
  if (filters.overdue) params.set('overdue', '1');
  const query = params.toString();
  return query ? `/inbox?${query}` : '/inbox';
}

function queryFor(filters: InboxFilters, cursor?: string): string {
  const params = new URLSearchParams();
  if (filters.reason) params.set('reason', filters.reason);
  if (filters.overdue) params.set('overdue', '1');
  if (cursor) params.set('cursor', cursor);
  const query = params.toString();
  return query ? `?${query}` : '';
}

export async function fetchNeedsYouPage(
  filters: InboxFilters,
  cursor?: string,
  signal?: AbortSignal
): Promise<NeedsYouPage> {
  const response = await fetch(
    withPageProjectScope(`/api/v1/needs-you${queryFor(filters, cursor)}`),
    {
      cache: 'no-store',
      signal,
    }
  );
  const body = (await response.json().catch(() => null)) as NeedsYouPage | null;
  if (!response.ok || !body?.ok || !Array.isArray(body.items)) throw new Error('needs-you');
  return body;
}

export async function fetchNeedsYouSummary(signal?: AbortSignal): Promise<NeedsYouSummary> {
  const response = await fetch(withPageProjectScope('/api/v1/needs-you/summary'), {
    cache: 'no-store',
    signal,
  });
  const body = (await response.json().catch(() => null)) as NeedsYouSummary | null;
  if (!response.ok || !body?.ok || typeof body.total !== 'number') throw new Error('needs-you');
  return body;
}

export type ApprovalDecisionItem = Pick<
  NonNullable<NeedsYouItem['approval']>,
  'id' | 'channel' | 'storage_channel' | 'presented_digest'
> & { min_assurance?: string };

/**
 * Approval → `/api/approvals/[id]` (A3 → passkey ceremony). Throws the
 * route's failure so the caller can show it. The one approval write helper.
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

/** Deliverable review → `/api/outcomes/[id]`. A change request needs a note. */
export async function postReviewVerdict(
  entryId: string,
  status: 'accepted' | 'changes_requested' | 'rejected',
  note = ''
): Promise<void> {
  if (status === 'changes_requested' && !note.trim()) throw new Error('note_required');
  const response = await fetch(`/api/outcomes/${encodeURIComponent(entryId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status, note }),
  });
  if (!response.ok) throw new Error('verdict_failed');
}

/** Knowledge candidate → `/api/memory-queue/[id]`. Returns the server's message. */
export async function postKnowledgeDecision(
  item: Pick<NonNullable<NeedsYouItem['knowledge']>, 'id' | 'candidateKey'>,
  decision: 'approve' | 'reject'
): Promise<string> {
  const response = await fetch(`/api/memory-queue/${encodeURIComponent(item.id)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      decision,
      ...(item.candidateKey ? { candidateKey: item.candidateKey } : {}),
    }),
  });
  const parsed = parseConciergeMutationResponse(await response.json().catch(() => null));
  if (!response.ok || !parsed?.result?.message) throw new Error('memory_decision_failed');
  return parsed.result.message;
}

/** Stalled request → `/api/hygiene/[id]` (start or withdraw). Returns the server's message. */
export async function postClarificationDecision(
  missionId: string,
  decision: 'start' | 'cancel',
  note = ''
): Promise<string> {
  const response = await fetch(`/api/hygiene/${encodeURIComponent(missionId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision, ...(note.trim() ? { note: note.trim() } : {}) }),
  });
  const parsed = parseConciergeMutationResponse(await response.json().catch(() => null));
  if (!response.ok || !parsed?.result?.message) throw new Error('hygiene_failed');
  return parsed.result.message;
}
