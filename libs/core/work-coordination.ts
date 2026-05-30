import * as crypto from 'node:crypto';

import { withExecutionContext } from './authority.js';
import { safeAppendFileSync, safeExistsSync, safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from './secure-io.js';

export type WorkItemStatus = 'backlog' | 'ready' | 'in_progress' | 'blocked' | 'review' | 'done' | 'archived';
export type WorkItemPriority = 'low' | 'normal' | 'high' | 'urgent';
export type WorkItemSource = 'local' | 'github' | 'jira' | 'peer';
export type WorkBoardType = 'project' | 'personal' | 'peer' | 'review' | 'external';
export type WorkLeaseStatus = 'active' | 'released' | 'expired';

export interface WorkItem {
  item_id: string;
  title: string;
  description: string;
  status: WorkItemStatus;
  priority: WorkItemPriority;
  source: WorkItemSource;
  source_ref: string;
  project_id: string;
  assignee_peer_id?: string;
  assignee_user_id?: string;
  labels: string[];
  dependencies: string[];
  version: number;
  created_at: string;
  updated_at: string;
  lease_id?: string;
  claimed_at?: string;
  released_at?: string;
  claimed_by_peer_id?: string;
  claimed_by_user_id?: string;
  metadata?: Record<string, unknown>;
}

export interface WorkBoardFilter {
  project_id?: string;
  source?: WorkItemSource | WorkItemSource[];
  status?: WorkItemStatus | WorkItemStatus[];
  assignee_peer_id?: string;
  assignee_user_id?: string;
  labels?: string[];
  text?: string;
}

export interface WorkBoard {
  board_id: string;
  name: string;
  type: WorkBoardType;
  description?: string;
  filters: WorkBoardFilter;
  sort_by: 'priority' | 'updated_at' | 'created_at' | 'status';
  lanes?: string[];
  created_at: string;
  updated_at: string;
}

export interface WorkLease {
  lease_id: string;
  item_id: string;
  holder_peer_id: string;
  holder_user_id?: string;
  purpose: string;
  status: WorkLeaseStatus;
  expires_at: string;
  created_at: string;
  renewed_at: string;
  released_at?: string;
  idempotency_key?: string;
  expected_version?: number;
  previous_lease_id?: string;
}

export type WorkCoordinationEventType =
  | 'item_imported'
  | 'item_created'
  | 'item_updated'
  | 'item_claimed'
  | 'item_released'
  | 'item_handed_off'
  | 'item_blocked'
  | 'item_unblocked'
  | 'review_requested'
  | 'external_sync_pulled'
  | 'external_sync_pushed'
  | 'conflict_detected'
  | 'board_created'
  | 'board_updated'
  | 'lease_expired';

export interface CoordinationEvent {
  event_id: string;
  ts: string;
  event_type: WorkCoordinationEventType;
  item_id?: string;
  board_id?: string;
  lease_id?: string;
  actor_peer_id?: string;
  actor_user_id?: string;
  command_id?: string;
  idempotency_key?: string;
  expected_version?: number;
  status?: string;
  note?: string;
  payload?: Record<string, unknown>;
}

export interface CreateWorkItemInput {
  itemId?: string;
  title: string;
  description: string;
  status?: WorkItemStatus;
  priority?: WorkItemPriority;
  source?: WorkItemSource;
  sourceRef?: string;
  projectId?: string;
  assigneePeerId?: string;
  assigneeUserId?: string;
  labels?: string[];
  dependencies?: string[];
  metadata?: Record<string, unknown>;
}

export interface UpdateWorkItemInput {
  itemId: string;
  expectedVersion?: number;
  title?: string;
  description?: string;
  status?: WorkItemStatus;
  priority?: WorkItemPriority;
  projectId?: string;
  assigneePeerId?: string;
  assigneeUserId?: string;
  labels?: string[];
  dependencies?: string[];
  metadata?: Record<string, unknown>;
}

export interface CreateBoardInput {
  boardId?: string;
  name: string;
  type: WorkBoardType;
  description?: string;
  filters?: WorkBoardFilter;
  sortBy?: WorkBoard['sort_by'];
  lanes?: string[];
}

export interface AppendCoordinationEventInput {
  eventType: WorkCoordinationEventType;
  itemId?: string;
  boardId?: string;
  leaseId?: string;
  actorPeerId?: string;
  actorUserId?: string;
  commandId?: string;
  idempotencyKey?: string;
  expectedVersion?: number;
  status?: string;
  note?: string;
  payload?: Record<string, unknown>;
}

export interface ClaimWorkItemInput {
  itemId: string;
  actorPeerId: string;
  actorUserId?: string;
  purpose: string;
  ttlMs?: number;
  expectedVersion?: number;
  idempotencyKey?: string;
}

export interface ReleaseWorkItemInput {
  itemId: string;
  leaseId: string;
  actorPeerId: string;
  actorUserId?: string;
  expectedVersion?: number;
  nextStatus?: WorkItemStatus;
}

export interface RenewWorkItemLeaseInput {
  leaseId: string;
  ttlMs?: number;
  expectedVersion?: number;
}

export interface HandoffWorkItemInput {
  itemId: string;
  fromLeaseId: string;
  fromPeerId: string;
  toPeerId: string;
  toUserId?: string;
  purpose: string;
  ttlMs?: number;
  expectedVersion?: number;
  idempotencyKey?: string;
}

export interface WorkItemFilter {
  boardId?: string;
  projectId?: string;
  source?: WorkItemSource | WorkItemSource[];
  status?: WorkItemStatus | WorkItemStatus[];
  assigneePeerId?: string;
  assigneeUserId?: string;
  labels?: string[];
  text?: string;
}

export interface WorkCoordinationErrorDetails {
  [key: string]: unknown;
}

export class WorkCoordinationError extends Error {
  constructor(
    public readonly code:
      | 'item_not_found'
      | 'board_not_found'
      | 'lease_conflict'
      | 'lease_not_found'
      | 'version_conflict'
      | 'validation_error'
      | 'idempotency_conflict'
      | 'board_conflict',
    message: string,
    public readonly details: WorkCoordinationErrorDetails = {},
  ) {
    super(message);
    this.name = 'WorkCoordinationError';
  }
}

const STORE_ROOT = 'active/shared/runtime/work-coordination';
const OBS_ROOT = 'active/shared/observability/work-coordination';

const PRIORITY_RANK: Record<WorkItemPriority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};
let coordinationNamespaceOverride: string | null = null;

export function setWorkCoordinationNamespace(namespace: string | null | undefined): void {
  coordinationNamespaceOverride = namespace ? String(namespace).trim() : null;
}

export function clearWorkCoordinationNamespace(): void {
  coordinationNamespaceOverride = null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function randomId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function slugify(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || `board-${crypto.randomUUID().slice(0, 8)}`;
}

function coordinationNamespace(): string {
  return coordinationNamespaceOverride || String(process.env.KYBERION_WORK_COORDINATION_NAMESPACE || '').trim();
}

function runtimeRoot(): string {
  const namespace = coordinationNamespace();
  return namespace ? `${STORE_ROOT}/${namespace}` : STORE_ROOT;
}

function observabilityRoot(): string {
  const namespace = coordinationNamespace();
  return namespace ? `${OBS_ROOT}/${namespace}` : OBS_ROOT;
}

function itemsPath(): string {
  return `${runtimeRoot()}/items.jsonl`;
}

function leasesPath(): string {
  return `${runtimeRoot()}/leases.jsonl`;
}

function boardsPath(): string {
  return `${runtimeRoot()}/boards.json`;
}

function eventsPath(): string {
  return `${observabilityRoot()}/events.jsonl`;
}

function ensureStore(): void {
  safeMkdir(runtimeRoot(), { recursive: true });
  safeMkdir(observabilityRoot(), { recursive: true });
}

function readJsonl<T>(logicalPath: string): T[] {
  if (!safeExistsSync(logicalPath)) return [];
  const raw = String(safeReadFile(logicalPath, { encoding: 'utf8' }) || '');
  return raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function appendJsonl(logicalPath: string, record: unknown): void {
  withExecutionContext('infrastructure_sentinel', () => {
    ensureStore();
    safeAppendFileSync(logicalPath, `${JSON.stringify(record)}\n`, 'utf8');
  });
}

function readJson<T>(logicalPath: string): T | null {
  if (!safeExistsSync(logicalPath)) return null;
  return JSON.parse(String(safeReadFile(logicalPath, { encoding: 'utf8' }) || 'null')) as T;
}

function writeJson(logicalPath: string, value: unknown): void {
  withExecutionContext('infrastructure_sentinel', () => {
    ensureStore();
    safeWriteFile(logicalPath, JSON.stringify(value, null, 2));
  });
}

function latestById<T extends Record<string, any>>(records: T[], key: string): T[] {
  const index = new Map<string, T>();
  for (const record of records) {
    const value = record[key];
    if (typeof value === 'string' && value) {
      index.set(value, record);
    }
  }
  return Array.from(index.values());
}

function isTerminalStatus(status: WorkItemStatus): boolean {
  return status === 'done' || status === 'archived';
}

function normalizeArray(value?: string | string[]): string[] {
  if (Array.isArray(value)) return value.filter(Boolean).map((entry) => String(entry));
  if (typeof value === 'string' && value) return [value];
  return [];
}

function currentWorkItems(): WorkItem[] {
  const records = readJsonl<WorkItem>(itemsPath());
  return latestById(records, 'item_id')
    .map((item) => ({ ...item }))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

function currentWorkItem(itemId: string): WorkItem | null {
  const normalized = String(itemId || '').trim();
  if (!normalized) return null;
  const items = currentWorkItems();
  return items.find((item) => item.item_id === normalized) || null;
}

function currentLeaseRecords(): WorkLease[] {
  const records = readJsonl<WorkLease>(leasesPath());
  return latestById(records, 'lease_id').map((lease) => ({ ...lease }));
}

function currentLeaseForItem(itemId: string): WorkLease | null {
  const now = Date.now();
  const leases = currentLeaseRecords()
    .filter((lease) => lease.item_id === itemId)
    .filter((lease) => lease.status === 'active')
    .filter((lease) => new Date(lease.expires_at).getTime() > now)
    .sort((a, b) => a.renewed_at.localeCompare(b.renewed_at));
  return leases.length > 0 ? leases[leases.length - 1] : null;
}

function currentLeaseById(leaseId: string): WorkLease | null {
  const normalized = String(leaseId || '').trim();
  if (!normalized) return null;
  const leases = currentLeaseRecords();
  return leases.find((lease) => lease.lease_id === normalized) || null;
}

function appendItemSnapshot(item: WorkItem): WorkItem {
  appendJsonl(itemsPath(), item);
  return item;
}

function appendLeaseSnapshot(lease: WorkLease): WorkLease {
  appendJsonl(leasesPath(), lease);
  return lease;
}

function createEvent(payload: AppendCoordinationEventInput): CoordinationEvent {
  return {
    event_id: randomId('wce'),
    ts: nowIso(),
    event_type: payload.eventType,
    ...(payload.itemId ? { item_id: payload.itemId } : {}),
    ...(payload.boardId ? { board_id: payload.boardId } : {}),
    ...(payload.leaseId ? { lease_id: payload.leaseId } : {}),
    ...(payload.actorPeerId ? { actor_peer_id: payload.actorPeerId } : {}),
    ...(payload.actorUserId ? { actor_user_id: payload.actorUserId } : {}),
    ...(payload.commandId ? { command_id: payload.commandId } : {}),
    ...(payload.idempotencyKey ? { idempotency_key: payload.idempotencyKey } : {}),
    ...(typeof payload.expectedVersion === 'number' ? { expected_version: payload.expectedVersion } : {}),
    ...(payload.status ? { status: payload.status } : {}),
    ...(payload.note ? { note: payload.note } : {}),
    ...(payload.payload ? { payload: payload.payload } : {}),
  };
}

function appendEvent(payload: AppendCoordinationEventInput): CoordinationEvent {
  const event = createEvent(payload);
  appendJsonl(eventsPath(), event);
  return event;
}

function activeLeaseForItem(itemId: string): WorkLease | null {
  return currentLeaseForItem(itemId);
}

function assertVersion(item: WorkItem, expectedVersion?: number): void {
  if (typeof expectedVersion === 'number' && item.version !== expectedVersion) {
    throw new WorkCoordinationError('version_conflict', `version conflict for ${item.item_id}`, {
      item_id: item.item_id,
      expected_version: expectedVersion,
      current_version: item.version,
    });
  }
}

function materializeBoardCatalog(): { version: '1'; boards: WorkBoard[] } {
  const catalog = readJson<{ version: '1'; boards: WorkBoard[] }>(boardsPath());
  if (!catalog || catalog.version !== '1' || !Array.isArray(catalog.boards)) {
    return { version: '1', boards: [] };
  }
  return {
    version: '1',
    boards: catalog.boards.map((board) => ({ ...board })),
  };
}

function writeBoardCatalog(catalog: { version: '1'; boards: WorkBoard[] }): void {
  writeJson(boardsPath(), catalog);
}

function applyWorkItemFilters(items: WorkItem[], filter: WorkItemFilter): WorkItem[] {
  const sources = normalizeArray(filter.source);
  const statuses = normalizeArray(filter.status);
  const labelSet = new Set(normalizeArray(filter.labels));
  const query = filter.text ? filter.text.trim().toLowerCase() : '';

  return items.filter((item) => {
    if ((filter.projectId || (filter as any).project_id) && item.project_id !== (filter.projectId || (filter as any).project_id)) return false;
    if (sources.length > 0 && !sources.includes(item.source)) return false;
    if (statuses.length > 0 && !statuses.includes(item.status)) return false;
    if ((filter.assigneePeerId || (filter as any).assignee_peer_id) && item.assignee_peer_id !== (filter.assigneePeerId || (filter as any).assignee_peer_id)) return false;
    if ((filter.assigneeUserId || (filter as any).assignee_user_id) && item.assignee_user_id !== (filter.assigneeUserId || (filter as any).assignee_user_id)) return false;
    if (labelSet.size > 0) {
      const itemLabels = new Set(item.labels || []);
      for (const label of labelSet) {
        if (!itemLabels.has(label)) return false;
      }
    }
    if (query) {
      const haystack = [item.title, item.description, item.source_ref, item.project_id].join(' ').toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

function sortItems(items: WorkItem[], sortBy: WorkBoard['sort_by'] = 'updated_at'): WorkItem[] {
  return [...items].sort((a, b) => {
    switch (sortBy) {
      case 'priority':
        return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || b.updated_at.localeCompare(a.updated_at);
      case 'created_at':
        return b.created_at.localeCompare(a.created_at);
      case 'status':
        return a.status.localeCompare(b.status) || b.updated_at.localeCompare(a.updated_at);
      case 'updated_at':
      default:
        return b.updated_at.localeCompare(a.updated_at);
    }
  });
}

export function clearWorkCoordinationStore(): void {
  withExecutionContext('infrastructure_sentinel', () => {
    safeRmSync(runtimeRoot(), { recursive: true, force: true });
    safeRmSync(observabilityRoot(), { recursive: true, force: true });
  });
}

export function listWorkItems(filter: WorkItemFilter = {}): WorkItem[] {
  const items = applyWorkItemFilters(currentWorkItems(), filter);
  return sortItems(items, 'updated_at');
}

export function getWorkItem(itemId: string): WorkItem | null {
  return currentWorkItem(itemId);
}

export function createWorkItem(input: CreateWorkItemInput): WorkItem {
  const title = String(input.title || '').trim();
  const description = String(input.description || '').trim();
  if (!title) {
    throw new WorkCoordinationError('validation_error', 'title is required');
  }
  if (!description) {
    throw new WorkCoordinationError('validation_error', 'description is required');
  }
  const now = nowIso();
  const item: WorkItem = {
    item_id: input.itemId || randomId('witem'),
    title,
    description,
    status: input.status || 'backlog',
    priority: input.priority || 'normal',
    source: input.source || 'local',
    source_ref: input.sourceRef || input.itemId || randomId('src'),
    project_id: input.projectId || 'default',
    ...(input.assigneePeerId ? { assignee_peer_id: input.assigneePeerId } : {}),
    ...(input.assigneeUserId ? { assignee_user_id: input.assigneeUserId } : {}),
    labels: [...(input.labels || [])],
    dependencies: [...(input.dependencies || [])],
    version: 1,
    created_at: now,
    updated_at: now,
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
  appendItemSnapshot(item);
  appendEvent({
    eventType: 'item_created',
    itemId: item.item_id,
    status: item.status,
    note: `created ${item.title}`,
    payload: { project_id: item.project_id, priority: item.priority, source: item.source },
  });
  return item;
}

function updateItemSnapshot(
  current: WorkItem,
  patch: Partial<WorkItem>,
  options: { clearLease?: boolean } = {},
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
        }
        : activeLease
        ? {
            lease_id: activeLease.lease_id,
            claimed_at: current.claimed_at || activeLease.created_at,
            claimed_by_peer_id: activeLease.holder_peer_id,
            ...(activeLease.holder_user_id ? { claimed_by_user_id: activeLease.holder_user_id } : {}),
            released_at: undefined,
          }
        : {
            lease_id: undefined,
            claimed_at: undefined,
            released_at: undefined,
            claimed_by_peer_id: undefined,
            claimed_by_user_id: undefined,
          }),
  };
  appendItemSnapshot(next);
  return next;
}

export function updateWorkItem(input: UpdateWorkItemInput): WorkItem {
  const current = currentWorkItem(input.itemId);
  if (!current) {
    throw new WorkCoordinationError('item_not_found', `item not found: ${input.itemId}`);
  }
  assertVersion(current, input.expectedVersion);

  const nextStatus = input.status || current.status;
  const shouldClearLease = isTerminalStatus(nextStatus);
  const next = updateItemSnapshot(
    current,
    {
      ...(input.title ? { title: String(input.title) } : {}),
      ...(input.description ? { description: String(input.description) } : {}),
      status: nextStatus,
      ...(input.priority ? { priority: input.priority } : {}),
      ...(input.projectId ? { project_id: input.projectId } : {}),
      ...(input.assigneePeerId !== undefined ? { assignee_peer_id: input.assigneePeerId } : {}),
      ...(input.assigneeUserId !== undefined ? { assignee_user_id: input.assigneeUserId } : {}),
      ...(input.labels ? { labels: [...input.labels] } : {}),
      ...(input.dependencies ? { dependencies: [...input.dependencies] } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    },
    { clearLease: shouldClearLease },
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
  }

  appendEvent({
    eventType: 'item_updated',
    itemId: next.item_id,
    expectedVersion: input.expectedVersion,
    status: next.status,
    note: `updated ${next.item_id}`,
    payload: {
      changed_fields: Object.keys(input).filter((key) => key !== 'itemId' && key !== 'expectedVersion'),
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
    board_id: input.boardId || slugify(name),
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

export function listCoordinationEvents(filter: Partial<CoordinationEvent> = {}): CoordinationEvent[] {
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
  expectedVersion?: number,
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
  const current = currentWorkItem(input.itemId);
  if (!current) {
    throw new WorkCoordinationError('item_not_found', `item not found: ${input.itemId}`);
  }
  assertVersion(current, input.expectedVersion);
  const existingLease = activeLeaseForItem(current.item_id);
  const idempotencyKey = input.idempotencyKey?.trim();
  if (existingLease && idempotencyKey && existingLease.idempotency_key === idempotencyKey) {
    return { item: current, lease: existingLease };
  }
  if (existingLease) {
    throw new WorkCoordinationError('lease_conflict', `item is already leased: ${current.item_id}`, {
      item_id: current.item_id,
      lease_id: existingLease.lease_id,
    });
  }

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
    ...(typeof input.expectedVersion === 'number' ? { expected_version: input.expectedVersion } : {}),
  };
  appendLeaseSnapshot(lease);

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
  });

  appendLeaseEvent('item_claimed', current.item_id, lease, `claimed by ${input.actorPeerId}`, input.actorPeerId, input.actorUserId, input.expectedVersion);
  return { item: next, lease };
}

export function releaseWorkItem(input: ReleaseWorkItemInput): { item: WorkItem; lease: WorkLease } {
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
    throw new WorkCoordinationError('lease_conflict', `lease owner mismatch for ${current.item_id}`, {
      item_id: current.item_id,
      holder_peer_id: activeLease.holder_peer_id,
      actor_peer_id: input.actorPeerId,
    });
  }

  const now = nowIso();
  const released: WorkLease = {
    ...activeLease,
    status: 'released',
    released_at: now,
    renewed_at: activeLease.renewed_at,
  };
  appendLeaseSnapshot(released);

  const next: WorkItem = appendItemSnapshot({
    ...current,
    status: input.nextStatus || 'ready',
    version: current.version + 1,
    updated_at: now,
    lease_id: undefined,
    claimed_at: undefined,
    released_at: now,
    claimed_by_peer_id: undefined,
    claimed_by_user_id: undefined,
  });

  appendLeaseEvent('item_released', current.item_id, released, `released by ${input.actorPeerId}`, input.actorPeerId, input.actorUserId, input.expectedVersion);
  return { item: next, lease: released };
}

export function renewWorkItemLease(input: RenewWorkItemLeaseInput): WorkLease {
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
  const renewed: WorkLease = {
    ...current,
    expires_at: new Date(Date.now() + (input.ttlMs || 15 * 60 * 1000)).toISOString(),
    renewed_at: nowIso(),
  };
  appendLeaseSnapshot(renewed);
  return renewed;
}

export function expireWorkItemLeases(now: string = nowIso()): WorkLease[] {
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

export function handoffWorkItem(input: HandoffWorkItemInput): { item: WorkItem; fromLease: WorkLease; toLease: WorkLease } {
  const released = releaseWorkItem({
    itemId: input.itemId,
    leaseId: input.fromLeaseId,
    actorPeerId: input.fromPeerId,
    expectedVersion: input.expectedVersion,
    nextStatus: 'ready',
  });
  const claimed = claimWorkItem({
    itemId: input.itemId,
    actorPeerId: input.toPeerId,
    actorUserId: input.toUserId,
    purpose: input.purpose,
    ttlMs: input.ttlMs,
    expectedVersion: released.item.version,
    idempotencyKey: input.idempotencyKey,
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
  metadata?: Record<string, unknown>;
}): WorkItem {
  const existing = listWorkItems({ source: input.source }).find((item) => item.source_ref === input.sourceRef);
  if (existing) {
    return updateWorkItem({
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
      metadata: input.metadata || existing.metadata,
    });
  }
  const item = createWorkItem({
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
    metadata: input.metadata,
  });
  appendEvent({
    eventType: 'item_imported',
    itemId: item.item_id,
    status: item.status,
    payload: { source: input.source, source_ref: input.sourceRef },
  });
  return item;
}

export function normalizeWorkItemLabels(labels: string[] | undefined): string[] {
  return [...new Set((labels || []).map((label) => label.trim()).filter(Boolean))];
}

export function createDefaultWorkBoard(boardId: string, name: string, filters: WorkBoardFilter, type: WorkBoardType = 'project'): WorkBoard {
  return createBoard({ boardId, name, type, filters, sortBy: 'priority' });
}

export function describeWorkCoordinationStore(): Record<string, unknown> {
  return {
    items_path: itemsPath(),
    leases_path: leasesPath(),
    boards_path: boardsPath(),
    events_path: eventsPath(),
    item_count: listWorkItems().length,
    board_count: listBoards().length,
    active_lease_count: currentLeaseRecords().filter((lease) => lease.status === 'active' && new Date(lease.expires_at).getTime() > Date.now()).length,
  };
}

export function listActiveWorkLeases(): WorkLease[] {
  return currentLeaseRecords().filter((lease) => lease.status === 'active' && new Date(lease.expires_at).getTime() > Date.now());
}

export function ensureDefaultWorkCoordinationCatalog(): void {
  withExecutionContext('infrastructure_sentinel', () => {
    ensureStore();
  });
}
