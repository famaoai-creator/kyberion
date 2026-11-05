/**
 * Deep links into あなた待ち (`/inbox`, the one needs-you queue) and back.
 *
 * Pure and client-safe. Every approval link is built here — never by string
 * concatenation at the call site — so the `?request=` landing contract
 * (`inboxLandingHash` in `app/inbox/needs-you-card.tsx`) has one producer.
 * A link only addresses a card; the inbox re-reads the viewer server-side.
 */
import { workspaceQuery, workspaceSelectionFromQuery } from '@agent/core/surface/workspace-query';
import type { WorkspaceSelection } from '@agent/core/surface/workspace-scope';

export interface InboxApprovalLinkOptions {
  /** The mission whose admission the approval decides (mission-alignment links). */
  missionId?: string;
  /** The approval store channel, when the request id alone is not unique. */
  storageChannel?: string;
  /** The knowledge candidate the approval was opened from (learning review). */
  candidateKey?: string;
  /** The company the approval belongs to (the shell's selection hint). */
  tenant?: string;
  /** Organization / project / tier narrowing to keep across the move. */
  selection?: WorkspaceSelection;
}

/** `?candidateKey=` values a return link accepts (hash-like keys only). */
const CANDIDATE_KEY = /^[A-Za-z0-9._:-]{1,256}$/;

function appendSelection(
  params: URLSearchParams,
  selection: WorkspaceSelection | undefined,
  tenant: string | undefined
): void {
  if (selection) {
    for (const [key, value] of workspaceQuery(selection)) params.set(key, value);
  }
  if (tenant) params.set('tenant', tenant);
}

/** The card of one approval in あなた待ち: `/inbox?reason=approval&request=<id>…`. */
export function inboxHrefForApproval(
  requestId: string,
  options: InboxApprovalLinkOptions = {}
): string {
  const params = new URLSearchParams();
  params.set('reason', 'approval');
  params.set('request', requestId);
  if (options.missionId) params.set('mission', options.missionId);
  if (options.storageChannel) params.set('storageChannel', options.storageChannel);
  if (options.candidateKey) params.set('candidateKey', options.candidateKey);
  appendSelection(params, options.selection, options.tenant);
  return `/inbox?${params.toString()}`;
}

/** A knowledge candidate's row in the library (`/library?tab=knowledge&candidateKey=…`). */
export function libraryHrefForKnowledgeCandidate(
  candidateKey: string,
  tenant?: string,
  selection?: WorkspaceSelection
): string {
  const params = new URLSearchParams({ tab: 'knowledge' });
  params.set('candidateKey', candidateKey);
  appendSelection(params, selection, tenant);
  return `/library?${params.toString()}`;
}

/**
 * The way back from an approval opened from a knowledge candidate: the
 * candidate's library row, keeping the company / organization / project the
 * link carried. Null when the inbox was not opened from a candidate.
 */
export function inboxReturnToCandidateHref(search: string | URLSearchParams): string | null {
  const params =
    typeof search === 'string'
      ? new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
      : search;
  const candidateKey = params.get('candidateKey')?.trim();
  if (!candidateKey || !CANDIDATE_KEY.test(candidateKey) || !params.get('request')?.trim())
    return null;
  const selection = workspaceSelectionFromQuery(params);
  return libraryHrefForKnowledgeCandidate(candidateKey, undefined, selection);
}
