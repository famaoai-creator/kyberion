import * as crypto from 'node:crypto';
import * as path from 'node:path';
import AjvModule, { type ValidateFunction } from 'ajv';
import { slugify } from './text-utils.js';

import { withExecutionContext } from './authority.js';
import { enforceNhiActorPolicy } from './nhi-actor-verification.js';
import {
  safeAppendFileSync,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
} from './secure-io.js';
import { buildWorkItemHandoffPacket, type HandoffPacket } from './handoff-packet.js';
import { auditChain } from './audit-chain.js';
import { pathResolver } from './path-resolver.js';
import { compileSchemaFromPath } from './schema-loader.js';
import { resolveTenant } from './tenant-registry.js';

export type WorkItemStatus =
  'backlog' | 'ready' | 'in_progress' | 'blocked' | 'review' | 'done' | 'archived';
export type WorkItemPriority = 'low' | 'normal' | 'high' | 'urgent';
export type WorkItemSource = 'local' | 'github' | 'jira' | 'peer';
export type WorkBoardType = 'project' | 'personal' | 'peer' | 'review' | 'external';
export type WorkLeaseStatus = 'active' | 'released' | 'expired';

export interface WorkItemContext {
  organization_id?: string;
  tenant_slug?: string;
  mission_id?: string;
  project_id?: string;
  task_id?: string;
  work_shape?:
    | 'solution_project'
    | 'service_operation'
    | 'routine_operation'
    | 'incident_response'
    | 'governance_cadence'
    | 'improvement_experiment';
}

const Ajv = (AjvModule as any).default ?? AjvModule;
const workItemAjv = new Ajv({ allErrors: true });
const WORK_ITEM_SCHEMA_PATH = pathResolver.rootResolve('schemas/work-item.schema.json');
let workItemValidator: ValidateFunction | null = null;

function validateWorkItem(value: unknown): void {
  workItemValidator ??= compileSchemaFromPath(workItemAjv, WORK_ITEM_SCHEMA_PATH);
  if (workItemValidator(value)) return;
  const errors = (workItemValidator.errors || [])
    .map((error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`)
    .join('; ');
  throw new WorkCoordinationError('validation_error', `work-item schema violation: ${errors}`);
}

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
  current_attempt_id?: string;
  attempts?: WorkItemAttempt[];
  context?: WorkItemContext;
  metadata?: Record<string, unknown>;
}

export type WorkItemAttemptStatus =
  'running' | 'released' | 'completed' | 'blocked' | 'failed' | 'handed_off';

export interface WorkItemAttempt {
  attempt_id: string;
  run_id: string;
  status: WorkItemAttemptStatus;
  started_at: string;
  ended_at?: string;
  actor_peer_id?: string;
  actor_user_id?: string;
  lease_id?: string;
  summary?: string;
  blocked_reason?: string;
  failure_reason?: string;
  trace_id?: string;
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
  | 'handoff_written'
  | 'handoff_consumed'
  | 'item_blocked'
  | 'item_unblocked'
  | 'item_attempt_started'
  | 'item_attempt_released'
  | 'item_attempt_completed'
  | 'item_attempt_blocked'
  | 'item_attempt_failed'
  | 'mission_handoff_written'
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
  attempts?: WorkItemAttempt[];
  currentAttemptId?: string;
  context?: WorkItemContext;
  rootDir?: string;
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
  attempts?: WorkItemAttempt[];
  currentAttemptId?: string;
  context?: WorkItemContext;
  rootDir?: string;
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
  traceId?: string;
  metadata?: Record<string, unknown>;
}

export interface ReleaseWorkItemInput {
  itemId: string;
  leaseId: string;
  actorPeerId: string;
  actorUserId?: string;
  expectedVersion?: number;
  nextStatus?: WorkItemStatus;
  summary?: string;
  traceId?: string;
  metadata?: Record<string, unknown>;
}

export interface RenewWorkItemLeaseInput {
  leaseId: string;
  ttlMs?: number;
  expectedVersion?: number;
  /**
   * QM-01: when provided, the renewal is refused unless this actor still holds
   * the lease — a zombie worker whose lease was reaped and re-claimed cannot
   * keep an item alive by heartbeating the old lease id.
   */
  actorPeerId?: string;
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
  traceId?: string;
  correlationId?: string;
  handoffPacket?: HandoffPacket;
  metadata?: Record<string, unknown>;
}

export interface RecordMissionHandoffInput {
  missionId: string;
  fromPersona: string;
  toPersona: string;
  handoffPacket: HandoffPacket;
}

export interface WorkItemFilter {
  boardId?: string;
  projectId?: string;
  tenantSlugs?: string[];
  /** JSON/API spelling retained for cross-process work-item filters. */
  tenant_slugs?: string[];
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
    public readonly details: WorkCoordinationErrorDetails = {}
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
let coordinationRootOverride: string | null = null;

export function setWorkCoordinationNamespace(namespace: string | null | undefined): void {
  coordinationNamespaceOverride = namespace ? String(namespace).trim() : null;
}

export function clearWorkCoordinationNamespace(): void {
  coordinationNamespaceOverride = null;
}

function withCoordinationRoot<T>(rootDir: string | undefined, fn: () => T): T {
  const previousRoot = coordinationRootOverride;
  coordinationRootOverride = rootDir ? path.resolve(rootDir) : null;
  try {
    return fn();
  } finally {
    coordinationRootOverride = previousRoot;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeWorkItemContext(
  input: WorkItemContext,
  fallbackProjectId?: string
): WorkItemContext {
  const context: WorkItemContext = {};
  if (input.tenant_slug) context.tenant_slug = input.tenant_slug;
  if (input.organization_id) context.organization_id = input.organization_id;
  context.project_id = input.project_id || fallbackProjectId || 'default';
  if (input.mission_id) context.mission_id = input.mission_id;
  if (input.task_id) context.task_id = input.task_id;
  context.work_shape = input.work_shape || 'routine_operation';
  return context;
}

function randomId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function coordinationNamespace(): string {
  return (
    coordinationNamespaceOverride ||
    String(process.env.KYBERION_WORK_COORDINATION_NAMESPACE || '').trim()
  );
}

function runtimeRoot(): string {
  const namespace = coordinationNamespace();
  const base = coordinationRootOverride || pathResolver.rootDir();
  return path.resolve(base, namespace ? `${STORE_ROOT}/${namespace}` : STORE_ROOT);
}

function observabilityRoot(): string {
  const namespace = coordinationNamespace();
  const base = coordinationRootOverride || pathResolver.rootDir();
  return path.resolve(base, namespace ? `${OBS_ROOT}/${namespace}` : OBS_ROOT);
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
    .map((item) => ({
      ...item,
      ...(item.attempts ? { attempts: item.attempts.map((attempt) => ({ ...attempt })) } : {}),
    }))
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

function createWorkItemAttempt(input: {
  actorPeerId: string;
  actorUserId?: string;
  leaseId: string;
  traceId?: string;
  metadata?: Record<string, unknown>;
}): WorkItemAttempt {
  const now = nowIso();
  return {
    attempt_id: randomId('wattempt'),
    run_id: randomId('wrun'),
    status: 'running',
    started_at: now,
    actor_peer_id: input.actorPeerId,
    ...(input.actorUserId ? { actor_user_id: input.actorUserId } : {}),
    lease_id: input.leaseId,
    ...(input.traceId ? { trace_id: input.traceId } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
}

function finalizeWorkItemAttempt(
  current: WorkItem,
  nextStatus: Exclude<WorkItemAttemptStatus, 'running'>,
  input: {
    summary?: string;
    blockedReason?: string;
    failureReason?: string;
    traceId?: string;
    metadata?: Record<string, unknown>;
  } = {}
): { attempts: WorkItemAttempt[]; currentAttemptId?: string; attempt: WorkItemAttempt | null } {
  const attempts = [...(current.attempts || [])];
  const now = nowIso();
  const index = current.current_attempt_id
    ? attempts.findIndex((attempt) => attempt.run_id === current.current_attempt_id)
    : attempts.length - 1;
  if (index < 0) {
    return { attempts, currentAttemptId: undefined, attempt: null };
  }

  const previous = attempts[index];
  const attempt: WorkItemAttempt = {
    ...previous,
    status: nextStatus,
    ended_at: now,
    ...(input.summary ? { summary: input.summary } : {}),
    ...(input.blockedReason ? { blocked_reason: input.blockedReason } : {}),
    ...(input.failureReason ? { failure_reason: input.failureReason } : {}),
    ...(input.traceId ? { trace_id: input.traceId } : {}),
    ...(input.metadata ? { metadata: { ...(previous.metadata || {}), ...input.metadata } } : {}),
  };
  attempts[index] = attempt;
  return { attempts, currentAttemptId: undefined, attempt };
}

function appendWorkItemAttemptEvent(
  eventType: WorkCoordinationEventType,
  itemId: string,
  attempt: WorkItemAttempt | null,
  note: string,
  actorPeerId?: string,
  actorUserId?: string,
  expectedVersion?: number
): void {
  appendEvent({
    eventType,
    itemId,
    actorPeerId,
    actorUserId,
    expectedVersion,
    status: attempt?.status,
    note,
    payload: attempt
      ? {
          attempt_id: attempt.attempt_id,
          run_id: attempt.run_id,
          status: attempt.status,
          started_at: attempt.started_at,
          ended_at: attempt.ended_at,
          actor_peer_id: attempt.actor_peer_id,
          actor_user_id: attempt.actor_user_id,
          lease_id: attempt.lease_id,
          summary: attempt.summary,
          blocked_reason: attempt.blocked_reason,
          failure_reason: attempt.failure_reason,
          trace_id: attempt.trace_id,
          metadata: attempt.metadata,
        }
      : undefined,
  });
}

function appendItemSnapshot(item: WorkItem): WorkItem {
  validateWorkItem(item);
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
    ...(typeof payload.expectedVersion === 'number'
      ? { expected_version: payload.expectedVersion }
      : {}),
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
    const tenantSlugs = filter.tenantSlugs || filter.tenant_slugs;
    if (tenantSlugs) {
      const tenantSlug = item.context?.tenant_slug;
      if (!tenantSlug || !tenantSlugs.includes(tenantSlug)) return false;
    }
    if (
      (filter.projectId || (filter as any).project_id) &&
      item.project_id !== (filter.projectId || (filter as any).project_id)
    )
      return false;
    if (sources.length > 0 && !sources.includes(item.source)) return false;
    if (statuses.length > 0 && !statuses.includes(item.status)) return false;
    if (
      (filter.assigneePeerId || (filter as any).assignee_peer_id) &&
      item.assignee_peer_id !== (filter.assigneePeerId || (filter as any).assignee_peer_id)
    )
      return false;
    if (
      (filter.assigneeUserId || (filter as any).assignee_user_id) &&
      item.assignee_user_id !== (filter.assigneeUserId || (filter as any).assignee_user_id)
    )
      return false;
    if (labelSet.size > 0) {
      const itemLabels = new Set(item.labels || []);
      for (const label of labelSet) {
        if (!itemLabels.has(label)) return false;
      }
    }
    if (query) {
      const haystack = [item.title, item.description, item.source_ref, item.project_id]
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

function sortItems(items: WorkItem[], sortBy: WorkBoard['sort_by'] = 'updated_at'): WorkItem[] {
  return [...items].sort((a, b) => {
    switch (sortBy) {
      case 'priority':
        return (
          PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
          b.updated_at.localeCompare(a.updated_at)
        );
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
    const hasTypedContext = Boolean(item.context?.project_id && item.context?.work_shape);
    if (hasTypedContext) continue;
    const context = normalizeWorkItemContext(
      {
        ...(item.context || {}),
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
      },
      item.project_id
    );
    if (!options.apply) {
      remaining.push(item.item_id);
      continue;
    }
    updateWorkItem({ itemId: item.item_id, context });
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
  return withCoordinationRoot(input.rootDir, () => createWorkItemInternal(input));
}

function createWorkItemInternal(input: CreateWorkItemInput): WorkItem {
  const title = String(input.title || '').trim();
  const description = String(input.description || '').trim();
  if (!title) {
    throw new WorkCoordinationError('validation_error', 'title is required');
  }
  if (!description) {
    throw new WorkCoordinationError('validation_error', 'description is required');
  }
  const now = nowIso();
  const context = normalizeWorkItemContext(input.context || {}, input.projectId);
  if (
    context.tenant_slug &&
    (process.env.KYBERION_ENTITY_GOVERNANCE === 'enforce' || !process.env.VITEST)
  ) {
    resolveTenant(context.tenant_slug, {
      rootDir: coordinationRootOverride || undefined,
      env: process.env,
    });
  }
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
    ...(input.currentAttemptId ? { current_attempt_id: input.currentAttemptId } : {}),
    ...(input.attempts ? { attempts: input.attempts.map((attempt) => ({ ...attempt })) } : {}),
    context,
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
  auditChain.record({
    agentId: process.env.KYBERION_PERSONA || 'work-coordination',
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
  return withCoordinationRoot(input.rootDir, () => updateWorkItemInternal(input));
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
  if (existingLease && idempotencyKey && existingLease.idempotency_key === idempotencyKey) {
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

  const next: WorkItem = appendItemSnapshot({
    ...current,
    status: input.nextStatus || 'ready',
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
  });

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
  const now = options.now ?? nowIso();
  const maxClaims = options.maxClaimAttempts ?? DEFAULT_MAX_CLAIM_ATTEMPTS;
  const maxErrors = options.maxErrorAttempts ?? DEFAULT_MAX_ERROR_ATTEMPTS;
  const expired = expireWorkItemLeases(now);
  const recovered: WorkItem[] = [];
  const parked: WorkItem[] = [];
  const replayed: WorkItem[] = [];

  for (const item of currentWorkItems()) {
    if (item.status !== 'in_progress') continue;
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

  return { expired, recovered, parked, replayed };
}

export function handoffWorkItem(input: HandoffWorkItemInput): {
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
  const released = releaseWorkItem({
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
  const claimed = claimWorkItem({
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
  const existing = listWorkItems({ source: input.source }).find(
    (item) => item.source_ref === input.sourceRef
  );
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
      context: input.context || existing.context,
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
