import {
  continueSuspendedPipelineWorkItem,
  type ResumeSuspendedPipelineWorkItemInput,
} from './work-coordination-pipeline-continuation.js';
import { readWorkItemInventoryAtPath } from './work-coordination-inventory.js';
import { finalizeWorkItemAttempt } from './work-item-attempt.js';
import * as crypto from 'node:crypto';
import { slugify } from '../foundation/text.js';
import { nowIso } from '../foundation/time.js';
import { getRegisteredEnvText } from '../foundation/env.js';
import { withExecutionContext } from '../authority.js';
import { withImmutableWorkItemInventorySnapshot } from './work-coordination-snapshot.js';
import { enforceNhiActorPolicy } from '../nhi-actor-verification.js';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat, safeRmSync } from '../secure-io.js';
import { buildWorkItemHandoffPacket, type HandoffPacket } from '../mesh/handoff-packet.js';
import { auditChain } from '../governance/audit-chain.js';
import { pathResolver } from '../path-resolver.js';
import { defineCatalog } from '../foundation/governed-catalog.js';
import { WorkCoordinationError, assertWorkClaimsAllowed } from './work-coordination-error.js';
import { settledWorkEffect, workEffectOwnership } from './work-effect-ownership.js';
import {
  assertEffectClaimable,
  claimedEffectOwnership,
  prepareEffectSettlement,
  prepareHumanEffectRelease,
  effectReleaseEvent,
  type EffectReleaseInput,
} from './work-effect-transitions.js';
import { applyWorkItemFilters, sortItems } from './work-coordination-query.js';
import {
  assertOriginalWorkItemIdentity,
  assertVersion,
  assertWorkItemTenantRegistered,
  buildWorkItemCreation,
  canReplayWorkItemClaim,
  isTerminalStatus,
  normalizeWorkItemContext,
} from './work-coordination-identity.js';
import {
  hasUndispatchedWorkItemEvidenceScope,
  inspectUndispatchedWorkItemHistory,
  isUndispatchedWorkItemSelector,
  type UndispatchedWorkItemEvidence,
  type UndispatchedWorkItemSelector,
} from './work-coordination-evidence.js';
export type {
  UndispatchedWorkItemEvidence,
  UndispatchedWorkItemSelector,
} from './work-coordination-evidence.js';
export { WorkCoordinationError } from './work-coordination-error.js';
import type {
  AppendCoordinationEventInput,
  ClaimWorkItemInput,
  CoordinationEvent,
  CreateBoardInput,
  CreateWorkItemInput,
  HandoffWorkItemInput,
  RecordMissionHandoffInput,
  ReleaseWorkItemInput,
  RenewWorkItemLeaseInput,
  UpdateWorkItemInput,
  WorkBoard,
  WorkBoardCatalog,
  WorkBoardFilter,
  WorkCoordinationEventType,
  WorkItem,
  WorkItemAttempt,
  WorkItemAttemptStatus,
  WorkItemContext,
  WorkItemFilter,
  WorkItemPriority,
  WorkItemSource,
  WorkItemStatus,
  WorkBoardType,
  WorkLease,
} from './work-coordination-types.js';
export type {
  AppendCoordinationEventInput,
  ClaimWorkItemInput,
  CoordinationEvent,
  CreateBoardInput,
  CreateWorkItemInput,
  HandoffWorkItemInput,
  RecordMissionHandoffInput,
  ReleaseWorkItemInput,
  RenewWorkItemLeaseInput,
  UpdateWorkItemInput,
  WorkBoard,
  WorkBoardCatalog,
  WorkBoardFilter,
  WorkCoordinationEventType,
  WorkItem,
  WorkItemAttempt,
  WorkItemAttemptStatus,
  WorkItemContext,
  WorkItemFilter,
  WorkItemPriority,
  WorkItemSource,
  WorkItemStatus,
  WorkBoardType,
  WorkLease,
  WorkLeaseStatus,
} from './work-coordination-types.js';

const WORK_BOARD_CATALOG_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/work-board-catalog.schema.json'
);
import {
  appendEvent,
  appendItemSnapshot,
  appendLeaseSnapshot,
  appendWorkItemAttemptEvent,
  boardsPath,
  coordinationRootOverride,
  createWorkItemAttempt,
  currentLeaseById,
  currentLeaseForItem,
  currentLeaseRecords,
  currentWorkItem,
  currentWorkItems,
  ensureStore,
  eventsPath,
  itemsPath,
  leasesPath,
  observabilityRoot,
  randomId,
  readJsonl,
  runtimeRoot,
  withCoordinationMutation,
  withCoordinationRoot,
  writeCoordinationState,
} from './work-coordination-ledger.js';
export {
  setWorkCoordinationNamespace,
  clearWorkCoordinationNamespace,
  MAX_RETAINED_ITEM_ATTEMPTS,
} from './work-coordination-ledger.js';

/** Record a mission-level handoff on every canonical WorkItem for the mission. */
export function recordMissionHandoff(input: RecordMissionHandoffInput): WorkItem[] {
  const missionId = input.missionId.toUpperCase();
  const items = listWorkItems().filter(
    (item) => item.project_id.toUpperCase() === missionId || item.metadata?.mission_id === missionId
  );
  const updated = items.map((item) =>
    updateWorkItem({
      itemId: item.item_id,
      expectedVersion: item.version,
      metadata: {
        ...(item.metadata || {}),
        handoff_packet: input.handoffPacket,
        handoff_from_persona: input.fromPersona,
        handoff_to_persona: input.toPersona,
        handoff_status: 'written',
      },
    })
  );
  appendEvent({
    eventType: 'mission_handoff_written',
    note: `mission handoff ${input.fromPersona} -> ${input.toPersona}`,
    payload: {
      mission_id: missionId,
      from_persona: input.fromPersona,
      to_persona: input.toPersona,
      handoff_packet: input.handoffPacket,
      item_ids: updated.map((item) => item.item_id),
    },
  });
  return updated;
}

function inspectUndispatchedWorkItemEvidence(
  input: UndispatchedWorkItemSelector
): UndispatchedWorkItemEvidence {
  try {
    if (!isUndispatchedWorkItemSelector(input))
      return { ok: false, reason: 'invalid_evidence_selector' };
    return inspectUndispatchedWorkItemHistory(input, {
      items: itemsPath(),
      leases: leasesPath(),
      events: eventsPath(),
    });
  } catch {
    return { ok: false, reason: 'incomplete_coordination_evidence' };
  }
}
/** Advisory read-only snapshot. A POST must revalidate under the mutation fence. */
export function readUndispatchedWorkItemEvidence(
  input: UndispatchedWorkItemSelector,
  options: { rootDir?: string } = {}
): UndispatchedWorkItemEvidence {
  return withCoordinationRoot(options.rootDir, () => inspectUndispatchedWorkItemEvidence(input));
}
const undispatchedEvidenceScopes: UndispatchedWorkItemSelector[] = [];
/** A terminal transcript write must be enclosed by the strict coordination proof callback. */
export function assertUndispatchedWorkItemEvidenceHeld(
  binding: {
    request_id: string;
    work_item_id: string;
  },
  links?: { actionRef: string; approvalRequestId: string }
): void {
  if (!hasUndispatchedWorkItemEvidenceScope(undispatchedEvidenceScopes, binding, links))
    throw new Error('strict coordination evidence fence required');
}
/** Caller holds the dispatch fence; callback may take the history fence, never vice versa. */
export function withUndispatchedWorkItemEvidence<T>(
  input: UndispatchedWorkItemSelector,
  callback: (evidence: Extract<UndispatchedWorkItemEvidence, { ok: true }>) => T,
  options: { rootDir?: string } = {}
): T {
  return withCoordinationRoot(options.rootDir, () =>
    withCoordinationMutation(() => {
      const evidence = inspectUndispatchedWorkItemEvidence(input);
      if (evidence.ok === false) throw new Error(evidence.reason);
      undispatchedEvidenceScopes.push(input);
      try {
        return callback(evidence);
      } finally {
        undispatchedEvidenceScopes.pop();
      }
    })
  );
}

function activeLeaseForItem(itemId: string): WorkLease | null {
  return currentLeaseForItem(itemId);
}

function workBoardCatalogAtPath(filePath: string) {
  return defineCatalog<WorkBoardCatalog>({
    id: 'work-board-catalog',
    path: filePath,
    schema: WORK_BOARD_CATALOG_SCHEMA_PATH,
  });
}

/** Load the persisted work-board catalog through the shared schema boundary. */
export function loadWorkBoardCatalogAtPath(filePath: string): WorkBoardCatalog {
  const safeFilePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: false });
  if (!safeLstat(safeFilePath).isFile()) {
    throw new Error(`[WORK_BOARD_CATALOG] catalog must be a regular file: ${filePath}`);
  }
  return workBoardCatalogAtPath(safeFilePath).load();
}

function materializeBoardCatalog(): WorkBoardCatalog {
  const filePath = boardsPath();
  if (!safeExistsSync(filePath)) return { version: '1', boards: [] };
  const catalog = loadWorkBoardCatalogAtPath(filePath);
  return {
    version: '1',
    boards: catalog.boards.map((board) => ({
      ...board,
      filters: { ...board.filters },
      ...(board.lanes ? { lanes: [...board.lanes] } : {}),
    })),
  };
}

function writeBoardCatalog(catalog: WorkBoardCatalog): void {
  const filePath = assertSafeRepositoryPath(boardsPath(), { allowMissingLeaf: true });
  const validated = workBoardCatalogAtPath(filePath).validate(catalog, filePath);
  writeCoordinationState(filePath, validated);
}

export function clearWorkCoordinationStore(): void {
  withCoordinationMutation(() => {
    safeRmSync(runtimeRoot(), { recursive: true, force: true });
    safeRmSync(observabilityRoot(), { recursive: true, force: true });
  });
}

export function listWorkItems(
  filter: WorkItemFilter = {},
  options: { rootDir?: string } = {}
): WorkItem[] {
  return withCoordinationRoot(options.rootDir, () => {
    const items = applyWorkItemFilters(currentWorkItems(), filter);
    return sortItems(items, 'updated_at');
  });
}

export function withWorkItemInventorySnapshot<T>(callback: (items: readonly WorkItem[]) => T): T {
  return withImmutableWorkItemInventorySnapshot(callback, withCoordinationMutation, listWorkItems);
}

/** Read-only base-schema inventory; diagnostic consumers validate execution evidence. */
export function readWorkItemInventory(options: { rootDir?: string } = {}): {
  present: boolean;
  items: WorkItem[];
} {
  return withCoordinationRoot(options.rootDir, () => readWorkItemInventoryAtPath(itemsPath()));
}

export function getWorkItem(itemId: string, options: { rootDir?: string } = {}): WorkItem | null {
  return withCoordinationRoot(options.rootDir, () => currentWorkItem(itemId));
}

/**
 * One-time governed migration for snapshots created before EG-06. New writes
 * never call this adapter; after it reports zero legacy items the old label /
 * metadata representation has no execution path in the core writer.
 */
export function migrateLegacyWorkItemContexts(options: { apply?: boolean } = {}): {
  migrated: string[];
  remaining: string[];
  migrated_context: number;
} {
  const migrated: string[] = [];
  const remaining: string[] = [];
  for (const item of currentWorkItems()) {
    const metadata = item.metadata || {};
    const missionLabel = item.labels.find((label) => label.startsWith('mission:'));
    const teamRoleLabel = item.labels.find((label) => label.startsWith('team_role:'));
    const legacyContext = {
      ...(typeof metadata.organization_id === 'string'
        ? { organization_id: metadata.organization_id }
        : {}),
      ...(typeof metadata.tenant_slug === 'string' ? { tenant_slug: metadata.tenant_slug } : {}),
      ...(typeof metadata.mission_id === 'string'
        ? { mission_id: metadata.mission_id }
        : missionLabel
          ? { mission_id: missionLabel.slice('mission:'.length) }
          : {}),
      ...(typeof metadata.task_id === 'string' ? { task_id: metadata.task_id } : {}),
    };
    // Migration fills gaps only: typed context remains authoritative on disagreement.
    const context = normalizeWorkItemContext(
      { ...legacyContext, ...(item.context || {}) },
      item.project_id
    );
    const teamRole =
      typeof metadata.team_role === 'string' && metadata.team_role.trim()
        ? metadata.team_role
        : teamRoleLabel?.slice('team_role:'.length).trim();
    const metadataUpdate = teamRole ? { ...metadata, team_role: teamRole } : metadata;
    const needsMigration =
      JSON.stringify(context) !== JSON.stringify(item.context || {}) ||
      metadataUpdate.team_role !== metadata.team_role;
    if (!needsMigration) continue;
    if (!options.apply) {
      remaining.push(item.item_id);
      continue;
    }
    updateWorkItem({
      itemId: item.item_id,
      expectedVersion: item.version,
      context,
      metadata: metadataUpdate,
    });
    migrated.push(item.item_id);
  }
  return { migrated, remaining, migrated_context: remaining.length };
}

export function listWorkItemAttempts(itemId: string): WorkItemAttempt[] {
  const item = currentWorkItem(itemId);
  if (!item) return [];
  return (item.attempts || []).map((attempt) => ({ ...attempt }));
}

export function createWorkItem(input: CreateWorkItemInput): WorkItem {
  return withCoordinationRoot(input.rootDir, () => {
    assertWorkItemTenantRegistered(input, coordinationRootOverride || undefined);
    return withCoordinationMutation(() => createWorkItemInternal(input));
  });
}

/**
 * Atomically create or replay the original creation identity under the store fence.
 * A committed snapshot survives event/audit interruption without duplicate creation.
 */
export function createWorkItemIfAbsent(input: CreateWorkItemInput & { itemId: string }): WorkItem {
  return withCoordinationRoot(input.rootDir, () => {
    assertWorkItemTenantRegistered(input, coordinationRootOverride || undefined);
    return withCoordinationMutation(() => {
      if (!input.itemId?.trim()) {
        throw new WorkCoordinationError('validation_error', 'itemId is required');
      }
      const candidate = buildWorkItemCreation(input);
      const records = readJsonl<WorkItem>(itemsPath()).filter(
        (item) => item.item_id === input.itemId
      );
      if (records.length === 0) return createWorkItemInternal(input);
      assertOriginalWorkItemIdentity(records, candidate);
      return records[records.length - 1];
    });
  });
}

function createWorkItemInternal(input: CreateWorkItemInput): WorkItem {
  const item = buildWorkItemCreation(input);
  if (currentWorkItem(item.item_id)) {
    throw new WorkCoordinationError(
      'idempotency_conflict',
      `work item already exists: ${item.item_id}`,
      { item_id: item.item_id }
    );
  }
  appendItemSnapshot(item);
  appendEvent({
    eventType: 'item_created',
    itemId: item.item_id,
    status: item.status,
    note: `created ${item.title}`,
    payload: { project_id: item.project_id, priority: item.priority, source: item.source },
  });
  auditChain.record({
    agentId: getRegisteredEnvText('KYBERION_PERSONA') || 'work-coordination',
    action: 'work_item.created',
    operation: `create:${item.item_id}`,
    result: 'completed',
    ...(item.context?.tenant_slug ? { tenantSlug: item.context.tenant_slug } : {}),
    metadata: { context: item.context, project_id: item.project_id },
  });
  return item;
}

function updateItemSnapshot(
  current: WorkItem,
  patch: Partial<WorkItem>,
  options: { clearLease?: boolean } = {}
): WorkItem {
  const now = nowIso();
  const activeLease = options.clearLease ? null : activeLeaseForItem(current.item_id);
  const next: WorkItem = {
    ...current,
    ...patch,
    version: current.version + 1,
    updated_at: now,
    ...(options.clearLease
      ? {
          lease_id: undefined,
          claimed_at: undefined,
          released_at: now,
          claimed_by_peer_id: undefined,
          claimed_by_user_id: undefined,
          current_attempt_id: undefined,
        }
      : activeLease
        ? {
            lease_id: activeLease.lease_id,
            claimed_at: current.claimed_at || activeLease.created_at,
            claimed_by_peer_id: activeLease.holder_peer_id,
            ...(activeLease.holder_user_id
              ? { claimed_by_user_id: activeLease.holder_user_id }
              : {}),
            released_at: undefined,
          }
        : {
            lease_id: undefined,
            claimed_at: undefined,
            released_at: undefined,
            claimed_by_peer_id: undefined,
            claimed_by_user_id: undefined,
          }),
    ...(patch.attempts ? { attempts: patch.attempts.map((attempt) => ({ ...attempt })) } : {}),
    ...(patch.current_attempt_id !== undefined
      ? { current_attempt_id: patch.current_attempt_id }
      : {}),
  };
  appendItemSnapshot(next);
  return next;
}

export function updateWorkItem(input: UpdateWorkItemInput): WorkItem {
  return withCoordinationRoot(input.rootDir, () =>
    withCoordinationMutation(() => updateWorkItemInternal(input))
  );
}

function updateWorkItemInternal(input: UpdateWorkItemInput): WorkItem {
  const current = currentWorkItem(input.itemId);
  if (!current) {
    throw new WorkCoordinationError('item_not_found', `item not found: ${input.itemId}`);
  }
  assertVersion(current, input.expectedVersion);

  const nextStatus = input.status || current.status;
  const shouldClearLease = isTerminalStatus(nextStatus);
  const attemptStatus: Exclude<WorkItemAttemptStatus, 'running'> =
    nextStatus === 'blocked'
      ? 'blocked'
      : nextStatus === 'done' || nextStatus === 'archived'
        ? 'completed'
        : 'released';
  const finalizedAttempt = shouldClearLease
    ? finalizeWorkItemAttempt(current, attemptStatus, {
        summary: typeof input.metadata?.summary === 'string' ? input.metadata.summary : undefined,
        blockedReason:
          typeof input.metadata?.blocked_reason === 'string'
            ? input.metadata.blocked_reason
            : undefined,
        failureReason:
          typeof input.metadata?.failure_reason === 'string'
            ? input.metadata.failure_reason
            : undefined,
        traceId: typeof input.metadata?.trace_id === 'string' ? input.metadata.trace_id : undefined,
        metadata: input.metadata,
      })
    : null;
  const next = updateItemSnapshot(
    current,
    {
      ...(workEffectOwnership(current) ? { effect_ownership: workEffectOwnership(current) } : {}),
      ...(input.title ? { title: String(input.title) } : {}),
      ...(input.description ? { description: String(input.description) } : {}),
      status: nextStatus,
      ...(input.priority ? { priority: input.priority } : {}),
      ...(input.projectId ? { project_id: input.projectId } : {}),
      ...(input.assigneePeerId !== undefined ? { assignee_peer_id: input.assigneePeerId } : {}),
      ...(input.assigneeUserId !== undefined ? { assignee_user_id: input.assigneeUserId } : {}),
      ...(input.labels ? { labels: [...input.labels] } : {}),
      ...(input.dependencies ? { dependencies: [...input.dependencies] } : {}),
      ...(input.context ? { context: { ...input.context } } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
      ...(finalizedAttempt
        ? {
            attempts: finalizedAttempt.attempts,
            current_attempt_id: finalizedAttempt.currentAttemptId,
          }
        : {}),
    },
    { clearLease: shouldClearLease }
  );

  if (shouldClearLease) {
    const lease = activeLeaseForItem(current.item_id);
    if (lease) {
      appendLeaseSnapshot({
        ...lease,
        status: 'released',
        released_at: nowIso(),
        renewed_at: lease.renewed_at,
      });
      appendEvent({
        eventType: 'item_released',
        itemId: next.item_id,
        leaseId: lease.lease_id,
        status: next.status,
        note: `released because status=${next.status}`,
      });
    }
    appendWorkItemAttemptEvent(
      attemptStatus === 'blocked' ? 'item_attempt_blocked' : 'item_attempt_completed',
      next.item_id,
      finalizedAttempt?.attempt || null,
      `attempt closed because status=${next.status}`,
      input.assigneePeerId,
      input.assigneeUserId,
      input.expectedVersion
    );
  }

  appendEvent({
    eventType: 'item_updated',
    itemId: next.item_id,
    expectedVersion: input.expectedVersion,
    status: next.status,
    note: `updated ${next.item_id}`,
    payload: {
      changed_fields: Object.keys(input).filter(
        (key) => key !== 'itemId' && key !== 'expectedVersion'
      ),
    },
  });
  return next;
}

export function listBoards(): WorkBoard[] {
  return materializeBoardCatalog().boards.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

export function getBoard(boardId: string): WorkBoard | null {
  const normalized = String(boardId || '').trim();
  if (!normalized) return null;
  return listBoards().find((board) => board.board_id === normalized) || null;
}

export function createBoard(input: CreateBoardInput): WorkBoard {
  const name = String(input.name || '').trim();
  if (!name) {
    throw new WorkCoordinationError('validation_error', 'name is required');
  }
  const now = nowIso();
  const catalog = materializeBoardCatalog();
  const board: WorkBoard = {
    board_id:
      input.boardId ||
      slugify(name, { maxLength: 80, fallback: `board-${crypto.randomUUID().slice(0, 8)}` }),
    name,
    type: input.type,
    ...(input.description ? { description: input.description } : {}),
    filters: input.filters || {},
    sort_by: input.sortBy || 'updated_at',
    ...(input.lanes ? { lanes: [...input.lanes] } : {}),
    created_at: now,
    updated_at: now,
  };

  const index = catalog.boards.findIndex((entry) => entry.board_id === board.board_id);
  if (index >= 0) {
    const merged: WorkBoard = {
      ...catalog.boards[index],
      ...board,
      created_at: catalog.boards[index].created_at,
      updated_at: now,
    };
    catalog.boards[index] = merged;
    writeBoardCatalog(catalog);
    appendEvent({
      eventType: 'board_updated',
      boardId: board.board_id,
      note: `updated board ${board.name}`,
    });
    return merged;
  } else {
    catalog.boards.push(board);
    writeBoardCatalog(catalog);
    appendEvent({
      eventType: 'board_created',
      boardId: board.board_id,
      note: `created board ${board.name}`,
    });
    return board;
  }
}

export function listBoardItems(boardId: string): WorkItem[] {
  const board = getBoard(boardId);
  if (!board) {
    throw new WorkCoordinationError('board_not_found', `board not found: ${boardId}`);
  }
  const items = applyWorkItemFilters(listWorkItems({}), board.filters);
  return sortItems(items, board.sort_by);
}

export function appendCoordinationEvent(input: AppendCoordinationEventInput): CoordinationEvent {
  const event = appendEvent(input);
  return event;
}

export function listCoordinationEvents(
  filter: Partial<CoordinationEvent> = {}
): CoordinationEvent[] {
  const events = readJsonl<CoordinationEvent>(eventsPath());
  return events.filter((event) => {
    if (filter.event_id && event.event_id !== filter.event_id) return false;
    if (filter.event_type && event.event_type !== filter.event_type) return false;
    if (filter.item_id && event.item_id !== filter.item_id) return false;
    if (filter.board_id && event.board_id !== filter.board_id) return false;
    if (filter.lease_id && event.lease_id !== filter.lease_id) return false;
    return true;
  });
}

function appendLeaseEvent(
  eventType: WorkCoordinationEventType,
  itemId: string,
  lease: WorkLease,
  note: string,
  actorPeerId?: string,
  actorUserId?: string,
  expectedVersion?: number
): void {
  appendEvent({
    eventType,
    itemId,
    leaseId: lease.lease_id,
    actorPeerId,
    actorUserId,
    expectedVersion,
    status: lease.status,
    note,
    payload: {
      lease_id: lease.lease_id,
      holder_peer_id: lease.holder_peer_id,
      holder_user_id: lease.holder_user_id,
      purpose: lease.purpose,
      expires_at: lease.expires_at,
    },
  });
}

export function claimWorkItem(input: ClaimWorkItemInput): { item: WorkItem; lease: WorkLease } {
  return withCoordinationMutation(() => claimWorkItemInternal(input));
}

export type { ResumeSuspendedPipelineWorkItemInput } from './work-coordination-pipeline-continuation.js';
const pipelineContinuationStore = {
  withCoordinationMutation,
  currentWorkItem,
  activeLeaseForItem,
  currentLeaseById,
  appendLeaseSnapshot,
  appendItemSnapshot,
  appendLeaseEvent,
  appendWorkItemAttemptEvent,
  randomId,
};
/** Continue the same protected held attempt after its exact human approval. */
export async function resumeSuspendedPipelineWorkItem(
  input: ResumeSuspendedPipelineWorkItemInput
): Promise<{ item: WorkItem; lease: WorkLease }> {
  const result = await continueSuspendedPipelineWorkItem(
    input,
    'resume',
    pipelineContinuationStore
  );
  return { item: result.item, lease: result.lease! };
}
/** Settle denied execution only from the exact protected terminal journal. */
export async function finalizeDeniedSuspendedPipelineWorkItem(
  input: ResumeSuspendedPipelineWorkItemInput
): Promise<WorkItem> {
  return (await continueSuspendedPipelineWorkItem(input, 'deny', pipelineContinuationStore)).item;
}

function claimWorkItemInternal(input: ClaimWorkItemInput): { item: WorkItem; lease: WorkLease } {
  assertWorkClaimsAllowed(input.itemId);
  // NI-02: the claimant actor is no longer an unverified free string. warn
  // (default) audits unregistered/inactive actors and allows; enforce rejects.
  enforceNhiActorPolicy(input.actorPeerId, 'work-coordination.claimWorkItem');
  const current = currentWorkItem(input.itemId);
  if (!current) {
    throw new WorkCoordinationError('item_not_found', `item not found: ${input.itemId}`);
  }
  assertVersion(current, input.expectedVersion);
  const existingLease = activeLeaseForItem(current.item_id);
  const idempotencyKey = input.idempotencyKey?.trim();
  if (existingLease && canReplayWorkItemClaim(current, existingLease, input)) {
    return { item: current, lease: existingLease };
  }
  if (existingLease) {
    throw new WorkCoordinationError(
      'lease_conflict',
      `item is already leased: ${current.item_id}`,
      {
        item_id: current.item_id,
        lease_id: existingLease.lease_id,
      }
    );
  }

  if (isTerminalStatus(current.status)) {
    throw new WorkCoordinationError(
      'validation_error',
      `cannot claim terminal work item: ${current.item_id}`,
      { item_id: current.item_id }
    );
  }

  const target = assertEffectClaimable(current, currentWorkItems());

  const now = nowIso();
  const lease: WorkLease = {
    lease_id: randomId('wlease'),
    item_id: current.item_id,
    holder_peer_id: input.actorPeerId,
    ...(input.actorUserId ? { holder_user_id: input.actorUserId } : {}),
    purpose: input.purpose,
    status: 'active',
    expires_at: new Date(Date.now() + (input.ttlMs || 15 * 60 * 1000)).toISOString(),
    created_at: now,
    renewed_at: now,
    ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
    ...(typeof input.expectedVersion === 'number'
      ? { expected_version: input.expectedVersion }
      : {}),
  };
  appendLeaseSnapshot(lease);

  const attempt = createWorkItemAttempt({
    actorPeerId: input.actorPeerId,
    actorUserId: input.actorUserId,
    leaseId: lease.lease_id,
    traceId: input.traceId,
    metadata: input.metadata,
  });

  const next: WorkItem = appendItemSnapshot({
    ...current,
    status: 'in_progress',
    version: current.version + 1,
    updated_at: now,
    lease_id: lease.lease_id,
    claimed_at: now,
    released_at: undefined,
    claimed_by_peer_id: input.actorPeerId,
    ...(input.actorUserId ? { claimed_by_user_id: input.actorUserId } : {}),
    current_attempt_id: attempt.run_id,
    attempts: [...(current.attempts || []), attempt],
    effect_ownership: claimedEffectOwnership(
      current,
      target,
      attempt.run_id,
      input.actorPeerId,
      now
    ),
  });

  appendLeaseEvent(
    'item_claimed',
    current.item_id,
    lease,
    `claimed by ${input.actorPeerId}`,
    input.actorPeerId,
    input.actorUserId,
    input.expectedVersion
  );
  appendWorkItemAttemptEvent(
    'item_attempt_started',
    current.item_id,
    attempt,
    `attempt started by ${input.actorPeerId}`,
    input.actorPeerId,
    input.actorUserId,
    input.expectedVersion
  );
  return { item: next, lease };
}

export function releaseWorkItem(input: ReleaseWorkItemInput): { item: WorkItem; lease: WorkLease } {
  return withCoordinationMutation(() => releaseWorkItemInternal(input));
}

/** Trailing run of attempts that ended 'released' carrying a failed execution status. */
function countTrailingFailedReleases(attempts: readonly WorkItemAttempt[]): number {
  let count = 0;
  for (let i = attempts.length - 1; i >= 0; i--) {
    const attempt = attempts[i];
    const executionStatus = (attempt.metadata as Record<string, unknown> | undefined)
      ?.execution_status;
    if (attempt.status === 'released' && executionStatus === 'failed') count++;
    else break;
  }
  return count;
}

function releaseWorkItemInternal(input: ReleaseWorkItemInput): {
  item: WorkItem;
  lease: WorkLease;
} {
  const current = currentWorkItem(input.itemId);
  if (!current) {
    throw new WorkCoordinationError('item_not_found', `item not found: ${input.itemId}`);
  }
  assertVersion(current, input.expectedVersion);
  const activeLease = activeLeaseForItem(current.item_id);
  if (!activeLease) {
    throw new WorkCoordinationError('lease_not_found', `no active lease for ${current.item_id}`, {
      item_id: current.item_id,
      lease_id: input.leaseId,
    });
  }
  if (activeLease.lease_id !== input.leaseId) {
    throw new WorkCoordinationError('lease_conflict', `lease mismatch for ${current.item_id}`, {
      item_id: current.item_id,
      expected_lease_id: input.leaseId,
      active_lease_id: activeLease.lease_id,
    });
  }
  if (activeLease.holder_peer_id !== input.actorPeerId) {
    throw new WorkCoordinationError(
      'lease_conflict',
      `lease owner mismatch for ${current.item_id}`,
      {
        item_id: current.item_id,
        holder_peer_id: activeLease.holder_peer_id,
        actor_peer_id: input.actorPeerId,
      }
    );
  }

  const now = nowIso();
  const effectOwnership = prepareEffectSettlement(current, input, now);
  const released: WorkLease = {
    ...activeLease,
    status: 'released',
    released_at: now,
    renewed_at: activeLease.renewed_at,
  };
  appendLeaseSnapshot(released);

  const finalAttempt = finalizeWorkItemAttempt(current, 'released', {
    summary: input.summary,
    traceId: input.traceId,
    metadata: input.metadata,
  });

  // Poison-pill guard on the normal release path (mirrors the reaper's lease
  // budget): a worker that claims, fails its delegation and releases back to
  // ready is instantly re-claimable, and was observed churning one item every
  // ~30 s indefinitely — thousands of snapshots that pushed the append-only
  // store past its read cap. Count trailing consecutive attempts released
  // with a failed execution status; past the error budget the item parks as
  // blocked instead of returning to ready.
  const trailingFailures = countTrailingFailedReleases(finalAttempt.attempts);
  const requestedStatus = input.nextStatus || 'ready';
  const shouldPark = requestedStatus === 'ready' && trailingFailures >= DEFAULT_MAX_ERROR_ATTEMPTS;

  const next: WorkItem = appendItemSnapshot({
    ...current,
    status: shouldPark ? 'blocked' : requestedStatus,
    effect_ownership: effectOwnership,
    version: current.version + 1,
    updated_at: now,
    ...(input.metadata ? { metadata: { ...(current.metadata || {}), ...input.metadata } } : {}),
    lease_id: undefined,
    claimed_at: undefined,
    released_at: now,
    claimed_by_peer_id: undefined,
    claimed_by_user_id: undefined,
    current_attempt_id: finalAttempt.currentAttemptId,
    attempts: finalAttempt.attempts,
    ...(shouldPark
      ? {
          metadata: {
            ...(current.metadata || {}),
            ...(input.metadata || {}),
            parked: true,
            parked_at: now,
            parked_reason: `release-path attempt budget exhausted (consecutive failures=${trailingFailures}/${DEFAULT_MAX_ERROR_ATTEMPTS})`,
          },
        }
      : {}),
  });

  if (shouldPark) {
    appendEvent({
      eventType: 'item_blocked',
      itemId: next.item_id,
      status: 'blocked',
      note: `parked on release: ${trailingFailures} consecutive failed attempts`,
    });
  }

  appendLeaseEvent(
    'item_released',
    current.item_id,
    released,
    `released by ${input.actorPeerId}`,
    input.actorPeerId,
    input.actorUserId,
    input.expectedVersion
  );
  appendWorkItemAttemptEvent(
    'item_attempt_released',
    current.item_id,
    finalAttempt.attempt,
    `attempt released by ${input.actorPeerId}`,
    input.actorPeerId,
    input.actorUserId,
    input.expectedVersion
  );
  return { item: next, lease: released };
}

/** Approval is reloaded inside the same fence as the one-snapshot ownership/status transition. */
export function releaseWorkItemEffectOwnership(input: EffectReleaseInput): WorkItem {
  return withCoordinationMutation(() => {
    const updated = appendItemSnapshot(
      prepareHumanEffectRelease(currentWorkItem(input.itemId), input, nowIso())
    );
    appendEvent(effectReleaseEvent(updated));
    return updated;
  });
}

export function renewWorkItemLease(input: RenewWorkItemLeaseInput): WorkLease {
  return withCoordinationMutation(() => renewWorkItemLeaseInternal(input));
}

function renewWorkItemLeaseInternal(input: RenewWorkItemLeaseInput): WorkLease {
  const current = currentLeaseById(input.leaseId);
  if (!current) {
    throw new WorkCoordinationError('lease_not_found', `lease not found: ${input.leaseId}`);
  }
  if (current.status !== 'active') {
    throw new WorkCoordinationError('lease_conflict', `lease is not active: ${input.leaseId}`, {
      lease_id: input.leaseId,
      status: current.status,
    });
  }
  if (input.actorPeerId && current.holder_peer_id !== input.actorPeerId) {
    throw new WorkCoordinationError(
      'lease_conflict',
      `lease holder mismatch for renewal: ${input.leaseId}`,
      {
        lease_id: input.leaseId,
        holder_peer_id: current.holder_peer_id,
        actor_peer_id: input.actorPeerId,
      }
    );
  }
  const expiresAtMs = new Date(current.expires_at).getTime();
  if (Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now()) {
    throw new WorkCoordinationError('lease_conflict', `lease already lapsed: ${input.leaseId}`, {
      lease_id: input.leaseId,
      expires_at: current.expires_at,
    });
  }
  const renewed: WorkLease = {
    ...current,
    expires_at: new Date(Date.now() + (input.ttlMs || 15 * 60 * 1000)).toISOString(),
    renewed_at: nowIso(),
  };
  appendLeaseSnapshot(renewed);
  return renewed;
}

export function expireWorkItemLeases(now: string = nowIso()): WorkLease[] {
  return withCoordinationMutation(() => expireWorkItemLeasesInternal(now));
}

function expireWorkItemLeasesInternal(now: string): WorkLease[] {
  const nowMs = new Date(now).getTime();
  const expired: WorkLease[] = [];
  for (const lease of currentLeaseRecords()) {
    if (lease.status === 'active' && new Date(lease.expires_at).getTime() <= nowMs) {
      const next: WorkLease = {
        ...lease,
        status: 'expired',
      };
      expired.push(next);
      appendLeaseSnapshot(next);
      appendLeaseEvent('lease_expired', lease.item_id, next, `expired lease ${lease.lease_id}`);
    }
  }
  return expired;
}

export interface ReapWorkLeasesOptions {
  now?: string;
  /**
   * Poison-pill guard (QM-01): a worker crash never records a failed attempt,
   * so parking must also trigger on total claim count, not only on failures.
   */
  maxClaimAttempts?: number;
  maxErrorAttempts?: number;
  /** CE-12: inject the durable mission/run-journal evidence reader. */
  completedEvidence?: (item: WorkItem) => boolean;
  /**
   * Reconcile only the stranded items this predicate accepts (e.g. the dot
   * executor reaps only items carrying `metadata.dot_id`). Lapsed leases are
   * still expired globally — an expired lease is dead for every holder.
   */
  itemFilter?: (item: WorkItem) => boolean;
}

export interface ReapWorkLeasesResult {
  expired: WorkLease[];
  /** Items whose stranded claim state was reset back to ready. */
  recovered: WorkItem[];
  /** Items parked (status: blocked) after exhausting their attempt budget. */
  parked: WorkItem[];
  /** Items completed by replaying durable evidence after a worker disappeared. */
  replayed: WorkItem[];
}

export const DEFAULT_MAX_CLAIM_ATTEMPTS = 5;
export const DEFAULT_MAX_ERROR_ATTEMPTS = 3;

/**
 * QM-01 reaper: expires lapsed leases AND reconciles the items they stranded —
 * an in_progress item without an active lease is reset to ready (its running
 * attempt finalized as released), or parked as blocked once its attempt budget
 * is exhausted. Without this, a crashed worker leaves the item claiming to be
 * in_progress forever, and a crash-looping item is re-claimed indefinitely.
 */
export function reapExpiredWorkLeases(options: ReapWorkLeasesOptions = {}): ReapWorkLeasesResult {
  return withCoordinationMutation(() => reapExpiredWorkLeasesInternal(options));
}

function reapExpiredWorkLeasesInternal(options: ReapWorkLeasesOptions): ReapWorkLeasesResult {
  const now = options.now ?? nowIso();
  const nowMs = new Date(now).getTime();
  const maxClaims = options.maxClaimAttempts ?? DEFAULT_MAX_CLAIM_ATTEMPTS;
  const maxErrors = options.maxErrorAttempts ?? DEFAULT_MAX_ERROR_ATTEMPTS;
  const expired = expireWorkItemLeasesInternal(now);
  const recovered: WorkItem[] = [];
  const parked: WorkItem[] = [];
  const replayed: WorkItem[] = [];

  for (const item of currentWorkItems()) {
    if (item.status !== 'in_progress') continue;
    if (options.itemFilter && !options.itemFilter(item)) continue;
    if (activeLeaseForItem(item.item_id)) continue;

    // Completion must come from the caller's durable evidence reader. A
    // work-item metadata flag is worker-controlled input and is not evidence.
    const completedEvidence = options.completedEvidence?.(item) === true;
    if (completedEvidence) {
      const finalAttempt = finalizeWorkItemAttempt(item, 'completed', {
        summary: 'completion evidence replayed after orphaned worker recovery',
        metadata: { ...(item.metadata || {}), replayed: true },
      });
      const next = appendItemSnapshot({
        ...item,
        status: 'done',
        effect_ownership: settledWorkEffect(item, 'completed', now),
        version: item.version + 1,
        updated_at: now,
        lease_id: undefined,
        claimed_at: undefined,
        released_at: now,
        claimed_by_peer_id: undefined,
        claimed_by_user_id: undefined,
        current_attempt_id: finalAttempt.currentAttemptId,
        attempts: finalAttempt.attempts,
        metadata: { ...(item.metadata || {}), replayed: true, replayed_at: now },
      });
      appendWorkItemAttemptEvent(
        'item_attempt_completed',
        item.item_id,
        finalAttempt.attempt,
        'completion evidence replayed after orphan recovery'
      );
      appendEvent({
        eventType: 'item_attempt_completed',
        itemId: item.item_id,
        status: 'done',
        note: 'orphaned completion replayed idempotently',
        payload: { replayed: true },
      });
      replayed.push(next);
      continue;
    }

    const finalAttempt = finalizeWorkItemAttempt(item, 'released', {
      failureReason: 'lease_expired',
      summary: 'lease expired without release; reaped',
    });
    const attempts = finalAttempt.attempts;
    const claimAttempts = attempts.length;
    const errorAttempts = attempts.filter(
      (attempt) => attempt.status === 'failed' || attempt.failure_reason === 'lease_expired'
    ).length;
    const shouldPark = claimAttempts >= maxClaims || errorAttempts >= maxErrors;

    const next: WorkItem = appendItemSnapshot({
      ...item,
      ...(workEffectOwnership(item) ? { effect_ownership: workEffectOwnership(item) } : {}),
      status: shouldPark ? 'blocked' : 'ready',
      version: item.version + 1,
      updated_at: now,
      lease_id: undefined,
      claimed_at: undefined,
      released_at: now,
      claimed_by_peer_id: undefined,
      claimed_by_user_id: undefined,
      current_attempt_id: finalAttempt.currentAttemptId,
      attempts,
      ...(shouldPark
        ? {
            metadata: {
              ...(item.metadata || {}),
              parked: true,
              parked_at: now,
              parked_reason: `attempt budget exhausted (claims=${claimAttempts}/${maxClaims}, errors=${errorAttempts}/${maxErrors})`,
            },
          }
        : {}),
    });

    appendWorkItemAttemptEvent(
      'item_attempt_released',
      item.item_id,
      finalAttempt.attempt,
      'attempt reaped after lease expiry'
    );
    if (shouldPark) {
      appendEvent({
        eventType: 'item_blocked',
        itemId: item.item_id,
        status: 'blocked',
        note: `parked by reaper: attempt budget exhausted (claims=${claimAttempts}, errors=${errorAttempts})`,
      });
      parked.push(next);
    } else {
      appendEvent({
        eventType: 'item_updated',
        itemId: item.item_id,
        status: 'ready',
        note: 'stranded claim reset by reaper after lease expiry',
      });
      recovered.push(next);
    }
  }

  // Orphaned-attempt reconcile: an item already back at a non-running status
  // (e.g. reset to ready/blocked by an operator while its lease was gone) can
  // still carry a `running` attempt whose lease no longer exists. Left alone it
  // poisons the record forever — claim-side only checks leases, so the item is
  // claimable while its own history claims an executor is still mid-flight.
  // Finalize the stale attempt so every attempt reaches a coherent terminal
  // state or a provably live lease.
  for (const item of currentWorkItems()) {
    if (item.status === 'in_progress') continue;
    if (options.itemFilter && !options.itemFilter(item)) continue;
    const runningAttempt = (item.attempts || []).find(
      (attempt) => attempt.status === 'running' && !attempt.ended_at
    );
    if (!runningAttempt) continue;
    if (activeLeaseForItem(item.item_id)) continue;
    const lease = currentLeaseById(runningAttempt.lease_id);
    if (lease?.status === 'active' && new Date(lease.expires_at).getTime() > nowMs) continue;

    const index = (item.attempts || []).findIndex(
      (attempt) => attempt.run_id === runningAttempt.run_id
    );
    const attempts = [...(item.attempts || [])];
    attempts[index] = {
      ...runningAttempt,
      status: 'released',
      ended_at: now,
      failure_reason: 'lease_lost',
      summary: 'running attempt orphaned without a live lease; reconciled by reaper',
    };
    const next = appendItemSnapshot({
      ...item,
      version: item.version + 1,
      updated_at: now,
      current_attempt_id:
        item.current_attempt_id === runningAttempt.run_id ? undefined : item.current_attempt_id,
      attempts,
    });
    appendWorkItemAttemptEvent(
      'item_attempt_released',
      item.item_id,
      attempts[index],
      'orphaned running attempt reconciled (lease lost)',
      undefined,
      undefined,
      item.version
    );
    appendEvent({
      eventType: 'item_updated',
      itemId: item.item_id,
      status: item.status,
      note: `stale running attempt ${runningAttempt.run_id} reconciled (lease lost)`,
      expectedVersion: item.version,
    });
    recovered.push(next);
  }

  return { expired, recovered, parked, replayed };
}

export function handoffWorkItem(input: HandoffWorkItemInput): {
  item: WorkItem;
  fromLease: WorkLease;
  toLease: WorkLease;
} {
  return withCoordinationMutation(() => handoffWorkItemInternal(input));
}

function handoffWorkItemInternal(input: HandoffWorkItemInput): {
  item: WorkItem;
  fromLease: WorkLease;
  toLease: WorkLease;
} {
  // NI-02: verify the receiving actor BEFORE releasing the from-lease — in
  // enforce mode a rejected toPeerId must not leave the item released and
  // unclaimed (the inner claimWorkItem would reject only after the release).
  enforceNhiActorPolicy(input.toPeerId, 'work-coordination.handoffWorkItem');
  const current = currentWorkItem(input.itemId);
  const currentAttemptId = current?.attempts?.find(
    (attempt) => attempt.run_id === current.current_attempt_id
  )?.attempt_id;
  const basePacket =
    input.handoffPacket ??
    buildWorkItemHandoffPacket({
      itemId: input.itemId,
      itemTitle: current?.title ?? input.itemId,
      purpose: input.purpose,
      fromPeerId: input.fromPeerId,
      toPeerId: input.toPeerId,
      correlationId: input.correlationId ?? input.traceId ?? input.idempotencyKey ?? input.itemId,
      attemptId: currentAttemptId,
      metadata: {
        ...(current?.metadata || {}),
        ...(input.metadata || {}),
      },
    });
  const packet: HandoffPacket = {
    ...basePacket,
    work_item_id: input.itemId,
    ...(currentAttemptId ? { attempt_id: currentAttemptId } : {}),
  };
  const nextMetadata = {
    ...(input.metadata || {}),
    handoff_packet: packet,
  };
  const released = releaseWorkItemInternal({
    itemId: input.itemId,
    leaseId: input.fromLeaseId,
    actorPeerId: input.fromPeerId,
    expectedVersion: input.expectedVersion,
    nextStatus: 'ready',
    summary: packet.outgoing_summary,
    traceId: input.traceId,
    metadata: nextMetadata,
  });
  appendEvent({
    eventType: 'handoff_written',
    itemId: input.itemId,
    leaseId: released.lease.lease_id,
    actorPeerId: input.fromPeerId,
    note: `handoff packet written for ${input.itemId}`,
    payload: { handoff_packet: packet, next_status: 'ready' },
  });
  const claimed = claimWorkItemInternal({
    itemId: input.itemId,
    actorPeerId: input.toPeerId,
    actorUserId: input.toUserId,
    purpose: input.purpose,
    ttlMs: input.ttlMs,
    expectedVersion: released.item.version,
    idempotencyKey: input.idempotencyKey,
    traceId: input.traceId,
    metadata: nextMetadata,
  });
  appendEvent({
    eventType: 'handoff_consumed',
    itemId: input.itemId,
    leaseId: claimed.lease.lease_id,
    actorPeerId: input.toPeerId,
    note: `handoff packet consumed by ${input.toPeerId}`,
    payload: { handoff_packet: packet, from_lease_id: released.lease.lease_id },
  });
  appendEvent({
    eventType: 'item_handed_off',
    itemId: input.itemId,
    leaseId: claimed.lease.lease_id,
    actorPeerId: input.toPeerId,
    note: `handoff ${input.fromPeerId} -> ${input.toPeerId}`,
    payload: {
      from_lease_id: input.fromLeaseId,
      to_lease_id: claimed.lease.lease_id,
      purpose: input.purpose,
      handoff_packet: packet,
    },
  });
  return { item: claimed.item, fromLease: released.lease, toLease: claimed.lease };
}

export function importExternalWorkItem(input: {
  source: WorkItemSource;
  sourceRef: string;
  title: string;
  description: string;
  status: WorkItemStatus;
  priority?: WorkItemPriority;
  projectId?: string;
  assigneePeerId?: string;
  assigneeUserId?: string;
  labels?: string[];
  dependencies?: string[];
  context?: WorkItemContext;
  metadata?: Record<string, unknown>;
}): WorkItem {
  // Tenant registration gates creation only (as before): re-syncing an item
  // that already exists keeps working even if its tenant was later suspended.
  // Checked under the caller's authority, outside the store fence. A re-sync
  // that moves the item to another tenant is validated like a creation.
  const previous = listWorkItems({ source: input.source }).find(
    (item) => item.source_ref === input.sourceRef
  );
  const tenant = input.context?.tenant_slug;
  if (!previous || (tenant !== undefined && tenant !== previous.context?.tenant_slug)) {
    assertWorkItemTenantRegistered(input, coordinationRootOverride || undefined);
  }
  return withCoordinationMutation(() => {
    const existing = listWorkItems({ source: input.source }).find(
      (item) => item.source_ref === input.sourceRef
    );
    if (existing) {
      return updateWorkItemInternal({
        itemId: existing.item_id,
        expectedVersion: existing.version,
        title: input.title,
        description: input.description,
        status: input.status,
        priority: input.priority || existing.priority,
        projectId: input.projectId || existing.project_id,
        assigneePeerId: input.assigneePeerId,
        assigneeUserId: input.assigneeUserId,
        labels: input.labels || existing.labels,
        dependencies: input.dependencies || existing.dependencies,
        context: input.context || existing.context,
        metadata: input.metadata || existing.metadata,
      });
    }
    const item = createWorkItemInternal({
      title: input.title,
      description: input.description,
      status: input.status,
      priority: input.priority,
      source: input.source,
      sourceRef: input.sourceRef,
      projectId: input.projectId,
      assigneePeerId: input.assigneePeerId,
      assigneeUserId: input.assigneeUserId,
      labels: input.labels,
      dependencies: input.dependencies,
      context: input.context,
      metadata: input.metadata,
    });
    appendEvent({
      eventType: 'item_imported',
      itemId: item.item_id,
      status: item.status,
      payload: { source: input.source, source_ref: input.sourceRef },
    });
    return item;
  });
}

export function normalizeWorkItemLabels(labels: string[] | undefined): string[] {
  return [...new Set((labels || []).map((label) => label.trim()).filter(Boolean))];
}

export function createDefaultWorkBoard(
  boardId: string,
  name: string,
  filters: WorkBoardFilter,
  type: WorkBoardType = 'project'
): WorkBoard {
  return createBoard({ boardId, name, type, filters, sortBy: 'priority' });
}

export function describeWorkCoordinationStore(): Record<string, unknown> {
  const items = listWorkItems();
  const activeAttempts = items.reduce(
    (count, item) =>
      count + (item.attempts || []).filter((attempt) => attempt.status === 'running').length,
    0
  );
  return {
    items_path: itemsPath(),
    leases_path: leasesPath(),
    boards_path: boardsPath(),
    events_path: eventsPath(),
    item_count: items.length,
    board_count: listBoards().length,
    active_lease_count: currentLeaseRecords().filter(
      (lease) => lease.status === 'active' && new Date(lease.expires_at).getTime() > Date.now()
    ).length,
    active_attempt_count: activeAttempts,
  };
}

export function listActiveWorkLeases(): WorkLease[] {
  return currentLeaseRecords().filter(
    (lease) => lease.status === 'active' && new Date(lease.expires_at).getTime() > Date.now()
  );
}

export function ensureDefaultWorkCoordinationCatalog(): void {
  withExecutionContext('infrastructure_sentinel', () => {
    ensureStore();
  });
}
