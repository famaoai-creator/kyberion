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

/** Preserve provenance on unchanged fields; never infer an old record's origin. */
export function workItemContextOrigin(
  context: WorkItemContext,
  previous?: Pick<WorkItem, 'context' | 'context_origin'>
): NonNullable<WorkItem['context_origin']> {
  const origin: NonNullable<WorkItem['context_origin']> = {};
  for (const key of ['project_id', 'work_shape'] as const) {
    if (previous && context[key] === previous.context?.[key]) {
      if (previous.context_origin?.[key]) origin[key] = previous.context_origin[key];
    } else if (context[key]) {
      origin[key] = 'explicit';
    }
  }
  return origin;
}

/** Context replacement and its descriptive provenance travel together. */
export function workItemContextUpdate(
  current: WorkItem,
  context?: WorkItemContext,
  keepOrigins = false
): Partial<Pick<WorkItem, 'context' | 'context_origin'>> {
  return context
    ? {
        context: { ...context },
        context_origin: keepOrigins
          ? { ...current.context_origin }
          : workItemContextOrigin(context, current),
      }
    : {};
}

/**
 * Reject a work item whose tenant is not registered and active. Call it under
 * the CALLER's authority, before entering the store fence: the fence assumes
 * infrastructure_sentinel, which may not read the personal-tier tenant
 * registry, so validating inside it failed every tenant-scoped create.
 */
export function assertWorkItemTenantRegistered(
  input: Pick<CreateWorkItemInput, 'context' | 'projectId'>,
  rootDir?: string
): void {
  const tenantSlug = input.context?.tenant_slug;
  if (
    tenantSlug &&
    (getRegisteredEnvText('KYBERION_ENTITY_GOVERNANCE') === 'enforce' || !isVitestProcess())
  ) {
    resolveTenant(tenantSlug, {
      rootDir,
      env: process.env,
    });
  }
}

export function buildWorkItemCreation(input: CreateWorkItemInput): WorkItem {
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
  const contextOrigin = workItemContextOrigin(input.context || {});
  contextOrigin.project_id = input.context?.project_id || input.projectId ? 'explicit' : 'default';
  contextOrigin.work_shape = input.context?.work_shape ? 'explicit' : 'default';
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
    context_origin: contextOrigin,
    ...(input.parentItemId ? { parent_item_id: input.parentItemId } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
  return item;
}

/** Original persisted creation fields, independent of later edits or claims. */
function creationIdentity(item: WorkItem): unknown {
  // D1: the parent link is structure, not creation identity — a backfill may
  // attach a parent to an item created before parents existed, and a replay of
  // that original creation must stay a replay. Value provenance is additive
  // metadata too: its introduction must not invalidate old creation replays.
  const {
    created_at: _created,
    updated_at: _updated,
    version: _version,
    parent_item_id: _parent,
    context_origin: _contextOrigin,
    ...identity
  } = item;
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
  const payloadHash = input.payloadHash?.trim();
  return Boolean(
    !input.requireNewLease &&
    idempotencyKey &&
    lease.idempotency_key === idempotencyKey &&
    // R5: same key with a different payload is never a replay. Backward
    // compatible: compared only when both the lease and the input carry a hash.
    (!payloadHash || !lease.payload_hash || lease.payload_hash === payloadHash) &&
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

/**
 * R5: the same claim idempotency key with a different payload hash is a
 * conflicting request, not a busy lease — fail with `idempotency_conflict`.
 */
export function assertClaimPayloadReplayable(lease: WorkLease, input: ClaimWorkItemInput): void {
  const idempotencyKey = input.idempotencyKey?.trim();
  const payloadHash = input.payloadHash?.trim();
  if (
    idempotencyKey &&
    lease.idempotency_key === idempotencyKey &&
    payloadHash &&
    lease.payload_hash &&
    lease.payload_hash !== payloadHash
  ) {
    throw new WorkCoordinationError(
      'idempotency_conflict',
      `claim idempotency key reused with a different payload: ${lease.item_id}`,
      { item_id: lease.item_id, lease_id: lease.lease_id }
    );
  }
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
