/**
 * Forge-agnostic binding between a WorkItem and the change request that
 * delivers it (a GitHub PR, a GitLab MR, a Gerrit change, or a plain local
 * branch). Nothing here calls a forge API: the branch is the join key every
 * forge shares, and `forge` / `ref` / `url` are opaque strings the caller
 * supplies. Whoever holds the item's work claim owns the change request, so
 * "which agent drives this PR?" is answered from the claim ledger alone.
 */
import { WorkCoordinationError } from './work-coordination-error.js';
import { isTerminalStatus } from './work-coordination-identity.js';
import type { WorkItem, WorkLease } from './work-coordination-types.js';
import {
  appendCoordinationEvent,
  getWorkItem,
  listActiveWorkLeases,
  listWorkItems,
  updateWorkItem,
} from './work-coordination.js';

export const CHANGE_REQUEST_STATES = ['open', 'merged', 'closed'] as const;
export type ChangeRequestState = (typeof CHANGE_REQUEST_STATES)[number];

/** Stored under `metadata.change_request` on the WorkItem. */
export interface WorkItemChangeRequest {
  branch: string;
  /** Free-form forge label ('github', 'gitlab', 'gerrit', 'local', ...). */
  forge?: string;
  /** Forge-native identifier ('1182', '!42', 'I3f2c…'); opaque to Kyberion. */
  ref?: string;
  url?: string;
  base_branch?: string;
  head_sha?: string;
  state: ChangeRequestState;
  linked_by_peer_id: string;
  linked_at: string;
  updated_at: string;
}

export interface ChangeRequestOwner {
  peer_id: string;
  user_id?: string;
  lease_id: string;
  lease_expires_at: string;
}

export interface ChangeRequestResolution {
  item: WorkItem;
  change_request: WorkItemChangeRequest;
  /** Null when nobody holds a live claim (unowned: anyone may claim it). */
  owner: ChangeRequestOwner | null;
}

const METADATA_KEY = 'change_request';
// git check-ref-format essentials: no spaces/control chars, no '..', no
// leading '-' or '/', no trailing '/', '.lock' or '.'.
const INVALID_BRANCH = /[\s~^:?*[\\\x00-\x1f\x7f]|\.\.|@\{|^[-/]|\/$|\.lock$|\.$|\/\//;

function optionalText(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) {
    throw new WorkCoordinationError('validation_error', `${field} must not be empty`);
  }
  return trimmed;
}

export function normalizeChangeRequestBranch(branch: string): string {
  const trimmed = String(branch || '')
    .trim()
    .replace(/^refs\/heads\//, '');
  if (!trimmed || INVALID_BRANCH.test(trimmed)) {
    throw new WorkCoordinationError('validation_error', `invalid branch name: '${branch}'`);
  }
  return trimmed;
}

function isChangeRequestState(value: unknown): value is ChangeRequestState {
  return (CHANGE_REQUEST_STATES as readonly unknown[]).includes(value);
}

/** The item's change request, or null when none (or a malformed one) is recorded. */
export function readWorkItemChangeRequest(item: WorkItem): WorkItemChangeRequest | null {
  const raw = item.metadata?.[METADATA_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.branch !== 'string' || !isChangeRequestState(record.state)) return null;
  if (typeof record.linked_by_peer_id !== 'string' || typeof record.linked_at !== 'string') {
    return null;
  }
  return record as unknown as WorkItemChangeRequest;
}

function liveLeaseFor(itemId: string, now: number = Date.now()): WorkLease | null {
  return (
    listActiveWorkLeases().find(
      (lease) => lease.item_id === itemId && Date.parse(lease.expires_at) > now
    ) || null
  );
}

function ownerFrom(lease: WorkLease | null): ChangeRequestOwner | null {
  if (!lease) return null;
  return {
    peer_id: lease.holder_peer_id,
    ...(lease.holder_user_id ? { user_id: lease.holder_user_id } : {}),
    lease_id: lease.lease_id,
    lease_expires_at: lease.expires_at,
  };
}

function requireItem(itemId: string): WorkItem {
  const item = getWorkItem(itemId);
  if (!item) throw new WorkCoordinationError('item_not_found', `item not found: ${itemId}`);
  return item;
}

function writeChangeRequest(item: WorkItem, changeRequest: WorkItemChangeRequest): WorkItem {
  return updateWorkItem({
    itemId: item.item_id,
    expectedVersion: item.version,
    metadata: { ...(item.metadata || {}), [METADATA_KEY]: changeRequest },
  });
}

export interface LinkWorkItemChangeRequestInput {
  itemId: string;
  actorPeerId: string;
  branch: string;
  forge?: string;
  ref?: string;
  url?: string;
  baseBranch?: string;
  headSha?: string;
}

/**
 * Bind a change request to a WorkItem. Only the live claim holder may link
 * (write = current claim holder), and a branch belongs to at most one
 * unfinished item so two agents never drive the same change request.
 */
export function linkWorkItemChangeRequest(input: LinkWorkItemChangeRequestInput): WorkItem {
  const item = requireItem(input.itemId);
  const actorPeerId = optionalText(input.actorPeerId, 'actorPeerId');
  if (!actorPeerId) {
    throw new WorkCoordinationError('validation_error', 'actorPeerId is required');
  }
  const lease = liveLeaseFor(item.item_id);
  if (!lease || lease.holder_peer_id !== actorPeerId) {
    throw new WorkCoordinationError(
      'lease_conflict',
      `${actorPeerId} does not hold the claim on ${item.item_id} — claim it first | next: pnpm work claim-item --item-id ${item.item_id} --actor-peer-id ${actorPeerId}`,
      { item_id: item.item_id, holder_peer_id: lease?.holder_peer_id ?? null }
    );
  }
  if (isTerminalStatus(item.status)) {
    throw new WorkCoordinationError(
      'validation_error',
      `${item.item_id} is ${item.status}; a finished item cannot take a new change request`
    );
  }
  const branch = normalizeChangeRequestBranch(input.branch);
  const other = listWorkItems().find(
    (candidate) =>
      candidate.item_id !== item.item_id &&
      !isTerminalStatus(candidate.status) &&
      readWorkItemChangeRequest(candidate)?.branch === branch
  );
  if (other) {
    throw new WorkCoordinationError(
      'lease_conflict',
      `branch '${branch}' is already linked to ${other.item_id} — hand that item off instead of linking twice`,
      { item_id: item.item_id, conflicting_item_id: other.item_id, branch }
    );
  }

  const previous = readWorkItemChangeRequest(item);
  const now = new Date().toISOString();
  const forge = optionalText(input.forge, 'forge');
  const ref = optionalText(input.ref, 'ref');
  const url = optionalText(input.url, 'url');
  const baseBranch =
    input.baseBranch !== undefined ? normalizeChangeRequestBranch(input.baseBranch) : undefined;
  const headSha = optionalText(input.headSha, 'headSha');
  const sameBranch = previous?.branch === branch;
  const changeRequest: WorkItemChangeRequest = {
    branch,
    ...(forge ? { forge } : sameBranch && previous?.forge ? { forge: previous.forge } : {}),
    ...(ref ? { ref } : sameBranch && previous?.ref ? { ref: previous.ref } : {}),
    ...(url ? { url } : sameBranch && previous?.url ? { url: previous.url } : {}),
    ...(baseBranch
      ? { base_branch: baseBranch }
      : sameBranch && previous?.base_branch
        ? { base_branch: previous.base_branch }
        : {}),
    ...(headSha
      ? { head_sha: headSha }
      : sameBranch && previous?.head_sha
        ? { head_sha: previous.head_sha }
        : {}),
    state: sameBranch && previous ? previous.state : 'open',
    linked_by_peer_id: actorPeerId,
    linked_at: sameBranch && previous ? previous.linked_at : now,
    updated_at: now,
  };
  const next = writeChangeRequest(item, changeRequest);
  appendCoordinationEvent({
    eventType: 'change_request_linked',
    itemId: next.item_id,
    leaseId: lease.lease_id,
    actorPeerId,
    status: changeRequest.state,
    note: `linked ${branch}${ref ? ` (${forge ? `${forge} ` : ''}${ref})` : ''} to ${next.item_id}`,
    payload: {
      change_request: changeRequest,
      ...(previous && !sameBranch ? { replaced_branch: previous.branch } : {}),
    },
  });
  return next;
}

export interface UpdateWorkItemChangeRequestInput {
  itemId: string;
  actorPeerId: string;
  state?: ChangeRequestState;
  headSha?: string;
  ref?: string;
  url?: string;
}

/**
 * Record what an observer saw on the forge (new head, merged, closed). While a
 * claim is live only its holder may write; after release (e.g. a merge seen
 * once the work is done) any observer may record the fact.
 */
export function updateWorkItemChangeRequest(input: UpdateWorkItemChangeRequestInput): WorkItem {
  const item = requireItem(input.itemId);
  const actorPeerId = optionalText(input.actorPeerId, 'actorPeerId');
  if (!actorPeerId) {
    throw new WorkCoordinationError('validation_error', 'actorPeerId is required');
  }
  const current = readWorkItemChangeRequest(item);
  if (!current) {
    throw new WorkCoordinationError(
      'validation_error',
      `${item.item_id} has no linked change request | next: pnpm work link-change --item-id ${item.item_id} --branch <branch>`
    );
  }
  if (input.state !== undefined && !isChangeRequestState(input.state)) {
    throw new WorkCoordinationError(
      'validation_error',
      `state must be one of ${CHANGE_REQUEST_STATES.join(', ')}`
    );
  }
  const lease = liveLeaseFor(item.item_id);
  if (lease && lease.holder_peer_id !== actorPeerId) {
    throw new WorkCoordinationError(
      'lease_conflict',
      `${item.item_id} is claimed by ${lease.holder_peer_id}; only the claim holder updates its change request`,
      { item_id: item.item_id, holder_peer_id: lease.holder_peer_id }
    );
  }
  const headSha = optionalText(input.headSha, 'headSha');
  const ref = optionalText(input.ref, 'ref');
  const url = optionalText(input.url, 'url');
  const changeRequest: WorkItemChangeRequest = {
    ...current,
    ...(input.state ? { state: input.state } : {}),
    ...(headSha ? { head_sha: headSha } : {}),
    ...(ref ? { ref } : {}),
    ...(url ? { url } : {}),
    updated_at: new Date().toISOString(),
  };
  const next = writeChangeRequest(item, changeRequest);
  appendCoordinationEvent({
    eventType: 'change_request_updated',
    itemId: next.item_id,
    ...(lease ? { leaseId: lease.lease_id } : {}),
    actorPeerId,
    status: changeRequest.state,
    note: `${changeRequest.branch} is ${changeRequest.state}`,
    payload: { change_request: changeRequest, previous_state: current.state },
  });
  return next;
}

export interface ResolveChangeRequestInput {
  branch?: string;
  forge?: string;
  ref?: string;
}

/**
 * Find the WorkItem behind a change request — by branch, or by forge + ref —
 * and who currently owns it. Unfinished items win over finished ones; among
 * equals the most recently updated wins.
 */
export function resolveChangeRequestOwner(
  input: ResolveChangeRequestInput
): ChangeRequestResolution | null {
  const branch = input.branch ? normalizeChangeRequestBranch(input.branch) : undefined;
  const ref = input.ref?.trim();
  if (!branch && !ref) {
    throw new WorkCoordinationError('validation_error', 'branch or ref is required');
  }
  const forge = input.forge?.trim();
  const matches = listWorkItems()
    .map((item) => ({ item, changeRequest: readWorkItemChangeRequest(item) }))
    .filter((entry): entry is { item: WorkItem; changeRequest: WorkItemChangeRequest } => {
      const cr = entry.changeRequest;
      if (!cr) return false;
      if (branch && cr.branch !== branch) return false;
      if (ref && cr.ref !== ref) return false;
      if (forge && cr.forge !== forge) return false;
      return true;
    })
    .sort((left, right) => {
      const leftDone = isTerminalStatus(left.item.status) ? 1 : 0;
      const rightDone = isTerminalStatus(right.item.status) ? 1 : 0;
      if (leftDone !== rightDone) return leftDone - rightDone;
      return right.item.updated_at.localeCompare(left.item.updated_at);
    });
  const match = matches[0];
  if (!match) return null;
  return {
    item: match.item,
    change_request: match.changeRequest,
    owner: ownerFrom(liveLeaseFor(match.item.item_id)),
  };
}

/** Every linked change request with its current owner, ordered by branch. */
export function listChangeRequestLinks(
  filter: { state?: ChangeRequestState } = {}
): ChangeRequestResolution[] {
  const leases = new Map(
    listActiveWorkLeases()
      .filter((lease) => Date.parse(lease.expires_at) > Date.now())
      .map((lease) => [lease.item_id, lease] as const)
  );
  return listWorkItems()
    .flatMap((item) => {
      const changeRequest = readWorkItemChangeRequest(item);
      if (!changeRequest) return [];
      if (filter.state && changeRequest.state !== filter.state) return [];
      return [
        {
          item,
          change_request: changeRequest,
          owner: ownerFrom(leases.get(item.item_id) || null),
        },
      ];
    })
    .sort((left, right) => left.change_request.branch.localeCompare(right.change_request.branch));
}
