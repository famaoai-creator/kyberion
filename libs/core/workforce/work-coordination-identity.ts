/** WorkItem creation identity and replay guards; mutation fencing stays in the store facade. */
import { randomUUID } from 'node:crypto';
import type { ValidateFunction } from 'ajv';
import { compileSchema } from '../foundation/ajv.js';
import { pathResolver } from '../path-resolver.js';
import { isDeepStrictEqual } from 'node:util';
import { getRegisteredEnvText, isVitestProcess } from '../foundation/env.js';
import { parseSafeJsonInput } from '../foundation/json.js';
import { nowIso } from '../foundation/time.js';
import { resolveTenant } from '../organization/tenant-registry.js';
import { WorkCoordinationError } from './work-coordination-error.js';
import type {
  ClaimWorkItemInput,
  CreateWorkItemInput,
  WorkItem,
  WorkItemContext,
  WorkItemStatus,
  WorkLease,
} from './work-coordination-types.js';

function randomId(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

export function normalizeWorkItemContext(
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

export function buildWorkItemCreation(input: CreateWorkItemInput, rootDir?: string): WorkItem {
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
    (getRegisteredEnvText('KYBERION_ENTITY_GOVERNANCE') === 'enforce' || !isVitestProcess())
  ) {
    resolveTenant(context.tenant_slug, {
      rootDir,
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
  return item;
}

/** Original persisted creation fields, independent of later edits or claims. */
function creationIdentity(item: WorkItem): unknown {
  const { created_at: _created, updated_at: _updated, version: _version, ...identity } = item;
  // Compare the persisted JSON representation (optional undefined values and
  // object key insertion order must not turn a replay into a false conflict).
  return parseSafeJsonInput(JSON.stringify(identity), 'work item creation identity');
}

/** Called only while the coordination store fence is held. */
export function assertOriginalWorkItemIdentity(records: WorkItem[], candidate: WorkItem): void {
  const original = records[0];
  // Multiple legacy creation snapshots make ownership ambiguous, even when
  // their current projections happen to agree. Never adopt that ID.
  if (
    original.version !== 1 ||
    records.filter((item) => item.version === 1).length !== 1 ||
    !isDeepStrictEqual(creationIdentity(original), creationIdentity(candidate))
  ) {
    throw new WorkCoordinationError(
      'idempotency_conflict',
      `work item creation identity conflict: ${candidate.item_id}`,
      { item_id: candidate.item_id }
    );
  }
}

/** A replay is a read of the same committed claim, never fresh executor ownership. */
export function canReplayWorkItemClaim(
  current: WorkItem,
  lease: WorkLease,
  input: ClaimWorkItemInput
): boolean {
  const idempotencyKey = input.idempotencyKey?.trim();
  return Boolean(
    !input.requireNewLease &&
    idempotencyKey &&
    lease.idempotency_key === idempotencyKey &&
    lease.holder_peer_id === input.actorPeerId &&
    lease.holder_user_id === input.actorUserId &&
    lease.purpose === input.purpose &&
    current.lease_id === lease.lease_id &&
    current.status === 'in_progress' &&
    current.attempts?.some(
      (attempt) =>
        attempt.run_id === current.current_attempt_id &&
        attempt.lease_id === lease.lease_id &&
        attempt.status === 'running'
    )
  );
}

const WORK_ITEM_SCHEMA_PATH = pathResolver.rootResolve(
  'knowledge/product/schemas/governed-work-item.schema.json'
);
let workItemValidator: ValidateFunction | null = null;

export function validateWorkItem(value: unknown): void {
  workItemValidator ??= compileSchema(WORK_ITEM_SCHEMA_PATH);
  if (workItemValidator(value)) return;
  const errors = (workItemValidator.errors || [])
    .map((error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`)
    .join('; ');
  throw new WorkCoordinationError('validation_error', `work-item schema violation: ${errors}`);
}

export function isTerminalStatus(status: WorkItemStatus): boolean {
  return status === 'done' || status === 'archived';
}

export function assertVersion(item: WorkItem, expectedVersion?: number): void {
  if (typeof expectedVersion === 'number' && item.version !== expectedVersion) {
    throw new WorkCoordinationError('version_conflict', `version conflict for ${item.item_id}`, {
      item_id: item.item_id,
      expected_version: expectedVersion,
      current_version: item.version,
    });
  }
}
