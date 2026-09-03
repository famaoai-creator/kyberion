import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import { pathResolver } from './path-resolver.js';
import { withExecutionContext } from './authority.js';
import { logger } from './core.js';
import { readJson } from './foundation/json.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { nowIso } from './foundation/time.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeMkdir,
  safeMoveSync,
  safeReaddir,
  safeRmSync,
  safeLstat,
} from './secure-io.js';
import {
  appendGovernedArtifactJsonl,
  writeGovernedArtifactJson,
  type GovernedArtifactRole,
} from './artifact-store.js';
import { getSurfaceCoordinationRole } from './surface-coordination-role-map.js';
import {
  normalizeEventScope,
  eventScopeMatches,
  type EventScope,
  type EventScopeInput,
} from './event-scope.js';
import { scopeContextKey } from './scope-context.js';
import { physicalScopedPath } from './physical-namespace.js';
import type {
  SlackOutboxMessage,
  SurfaceAsyncChannel,
  SurfaceAsyncRequestRecord,
  SurfaceDeadLetterRecord,
  SurfaceDeadTargetRecord,
  SurfaceDeliveryFailure,
  SurfaceNotificationRecord,
  SurfaceOutboxMessage,
} from './channel-surface-types.js';

const SURFACE_OUTBOX_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/surface-outbox-message.schema.json'
);

const surfaceOutboxCatalog = defineCatalog<SurfaceOutboxMessage>({
  id: 'surface-outbox-message',
  path: SURFACE_OUTBOX_SCHEMA_PATH,
  schema: SURFACE_OUTBOX_SCHEMA_PATH,
});

function resolveSurfaceScope(scope?: EventScopeInput): EventScope {
  return normalizeEventScope(scope || { scope_kind: 'system', tier: 'public' });
}

function scopeFilter(scope?: EventScopeInput): EventScope | undefined {
  return scope ? resolveSurfaceScope(scope) : undefined;
}

function recordMatchesScope(record: { scope?: EventScope }, filter?: EventScope): boolean {
  if (!filter) return true;
  if (record.scope && !isPersistedScope(record.scope)) return false;
  return eventScopeMatches(record.scope, {
    scope_kind: filter.scope_kind,
    tenant_slug: filter.tenant_slug,
    organization_id: filter.organization_id,
    project_id: filter.project_id,
    mission_id: filter.mission_id,
    task_id: filter.task_id,
    session_id: filter.session_id,
  });
}

function isPersistedScope(value: unknown): value is EventScope {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    normalizeEventScope(value as EventScopeInput);
    return true;
  } catch {
    return false;
  }
}

function surfaceCoordinationRole(surface: SurfaceAsyncChannel): GovernedArtifactRole {
  return getSurfaceCoordinationRole(surface);
}

function systemScope(): EventScope {
  return resolveSurfaceScope({ scope_kind: 'system', tier: 'public' });
}

function scopedLogicalPath(
  base: string,
  scope: EventScopeInput | undefined,
  ...parts: string[]
): string {
  return physicalScopedPath(base, scope ? resolveSurfaceScope(scope) : systemScope(), ...parts);
}

function asyncRequestBase(surface: SurfaceAsyncChannel): string {
  return surface === 'presence'
    ? 'active/shared/runtime/presence'
    : `active/shared/coordination/channels/${surface}`;
}

function notificationBase(surface: SurfaceAsyncChannel): string {
  return surface === 'presence'
    ? 'active/shared/runtime/presence'
    : `active/shared/coordination/channels/${surface}`;
}

function asyncRequestLogicalPath(
  surface: SurfaceAsyncChannel,
  requestId: string,
  scope?: EventScopeInput
): string {
  return scopedLogicalPath(asyncRequestBase(surface), scope, 'requests', `${requestId}.json`);
}

function surfaceNotificationLogicalPath(
  surface: SurfaceAsyncChannel,
  notificationId: string,
  scope?: EventScopeInput
): string {
  return scopedLogicalPath(
    notificationBase(surface),
    scope,
    'notifications',
    `${notificationId}.json`
  );
}

function surfaceOutboxBase(surface: SurfaceAsyncChannel): string {
  return `active/shared/coordination/channels/${surface}`;
}

function surfaceDeadLetterBase(surface: SurfaceAsyncChannel): string {
  return `active/shared/coordination/channels/${surface}`;
}

function surfaceOutboxLogicalPath(
  surface: SurfaceAsyncChannel,
  messageId: string,
  scope?: EventScopeInput
): string {
  return scopedLogicalPath(surfaceOutboxBase(surface), scope, 'outbox', `${messageId}.json`);
}

function surfaceDeadLetterLogicalPath(
  surface: SurfaceAsyncChannel,
  deadLetterId: string,
  scope?: EventScopeInput
): string {
  return scopedLogicalPath(
    surfaceDeadLetterBase(surface),
    scope,
    'dead-letter',
    `${deadLetterId}.json`
  );
}

function surfaceDeadTargetLogicalPath(
  surface: SurfaceAsyncChannel,
  channel: string,
  scope?: EventScopeInput
): string {
  const normalizedScope = scope ? resolveSurfaceScope(scope) : undefined;
  const scopeKey =
    normalizedScope && normalizedScope.scope_kind !== 'system'
      ? `\u0000${scopeContextKey(normalizedScope)}`
      : '';
  const key = createHash('sha256').update(`${channel}${scopeKey}`).digest('hex').slice(0, 32);
  return scopedLogicalPath(
    `active/shared/coordination/channels/${surface}`,
    normalizedScope,
    'dead-targets',
    `${key}.json`
  );
}

function surfaceDeadTargetBase(surface: SurfaceAsyncChannel): string {
  return `active/shared/coordination/channels/${surface}`;
}

function collectJsonFiles(root: string, recursive: boolean): string[] {
  let safeRoot: string;
  try {
    safeRoot = assertSafeRepositoryPath(root, { allowMissingLeaf: true });
    if (!safeExistsSync(safeRoot)) return [];
    const rootStat = safeLstat(safeRoot);
    if (!rootStat.isDirectory()) return [];
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes('[RESOURCE_PATH_SYMLINK]') ||
        (error as NodeJS.ErrnoException).code === 'ENOENT')
    ) {
      return [];
    }
    throw error;
  }
  return safeReaddir(safeRoot)
    .sort()
    .flatMap((name) => {
      if (name === '.quarantine') return [];
      const child = path.join(root, name);
      try {
        const safeChild = assertSafeRepositoryPath(child, { allowMissingLeaf: true });
        const stat = safeLstat(safeChild);
        if (stat.isDirectory()) return recursive ? collectJsonFiles(child, true) : [];
        return stat.isFile() && name.endsWith('.json') ? [safeChild] : [];
      } catch (error) {
        if (
          error instanceof Error &&
          (error.message.includes('[RESOURCE_PATH_SYMLINK]') ||
            (error as NodeJS.ErrnoException).code === 'ENOENT')
        ) {
          return [];
        }
        throw error;
      }
    });
}

function loadSurfaceRecordJson<T>(filePath: string): T {
  return readJson<T>(assertSafeRepositoryPath(filePath));
}

export function loadSurfaceOutboxMessageAtPath(
  filePath: string,
  surface: SurfaceAsyncChannel
): SurfaceOutboxMessage {
  const safeFilePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
  if (!safeLstat(safeFilePath).isFile()) {
    throw new Error(`[SURFACE_OUTBOX] outbox record must be a regular file: ${filePath}`);
  }
  const record = defineCatalog<SurfaceOutboxMessage>({
    id: 'surface-outbox-message',
    path: safeFilePath,
    schema: SURFACE_OUTBOX_SCHEMA_PATH,
  }).load();
  if (record.surface !== surface) {
    throw new Error(
      `[SURFACE_OUTBOX_SCOPE_MISMATCH] expected surface ${surface}, got ${record.surface}`
    );
  }
  if (!isPersistedScope(record.scope)) {
    throw new Error('[SURFACE_OUTBOX] persisted scope is invalid');
  }
  return record;
}

function validateSurfaceOutboxMessage(
  record: SurfaceOutboxMessage,
  sourcePath: string
): SurfaceOutboxMessage {
  const validated = surfaceOutboxCatalog.validate(record, sourcePath);
  if (!isPersistedScope(validated.scope)) {
    throw new Error('[SURFACE_OUTBOX] persisted scope is invalid');
  }
  return validated;
}

function hasPathSegments(filePath: string, parts: string[]): boolean {
  const segments = filePath.split(path.sep);
  for (let index = 0; index <= segments.length - parts.length; index += 1) {
    if (parts.every((part, offset) => segments[index + offset] === part)) return true;
  }
  return false;
}

export interface SurfaceRecordListOptions {
  scope?: EventScopeInput;
  /** System aggregate readers must opt in explicitly; default is system root only. */
  includeTenantNamespaces?: boolean;
}

function recordFiles(
  base: string,
  options: SurfaceRecordListOptions,
  ...parts: string[]
): string[] {
  const normalizedScope = options.scope ? resolveSurfaceScope(options.scope) : undefined;
  const aggregate = !normalizedScope && options.includeTenantNamespaces === true;
  const root = pathResolver.resolve(
    normalizedScope
      ? physicalScopedPath(base, normalizedScope, ...parts)
      : path.join(base, ...(aggregate ? [] : parts))
  );
  const files = collectJsonFiles(
    root,
    aggregate || (Boolean(normalizedScope) && normalizedScope!.scope_kind !== 'system')
  );
  return aggregate ? files.filter((filePath) => hasPathSegments(filePath, parts)) : files;
}

function findRecordPath(
  base: string,
  recordId: string,
  options: SurfaceRecordListOptions,
  ...parts: string[]
): string | null {
  const candidates = recordFiles(base, options, ...parts).filter(
    (candidate) => path.basename(candidate) === `${recordId}.json`
  );
  if (candidates.length > 1) {
    throw new Error(`[SURFACE_RECORD_ID_AMBIGUOUS] ${recordId}`);
  }
  return candidates[0] || null;
}

function quarantineSurfaceRecordFile(
  surface: SurfaceAsyncChannel,
  recordKind: 'async-request' | 'notification',
  recordDir: string,
  fileName: string,
  error: unknown
): void {
  const quarantineDir = path.join(recordDir, '.quarantine');
  const source = path.join(recordDir, fileName);
  const destination = path.join(
    quarantineDir,
    `${path.basename(fileName)}.${Date.now().toString(36)}-${randomUUID().slice(0, 8)}.quarantined`
  );
  try {
    withExecutionContext(surfaceCoordinationRole(surface), () => {
      if (!safeExistsSync(quarantineDir)) safeMkdir(quarantineDir, { recursive: true });
      safeMoveSync(source, destination);
    });
    logger.warn(
      `[surface-coordination] quarantined malformed ${recordKind} surface=${surface} file=${fileName}: ${error instanceof Error ? error.message : String(error)}`
    );
  } catch (quarantineError) {
    logger.warn(
      `[surface-coordination] failed to quarantine malformed ${recordKind} surface=${surface} file=${fileName}: ${quarantineError instanceof Error ? quarantineError.message : String(quarantineError)}`
    );
  }
}

function isSurfaceAsyncRequestRecord(
  value: unknown,
  surface: SurfaceAsyncChannel
): value is SurfaceAsyncRequestRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.surface === surface &&
    typeof record.request_id === 'string' &&
    typeof record.channel === 'string' &&
    typeof record.thread_ts === 'string' &&
    typeof record.sender_agent_id === 'string' &&
    typeof record.surface_agent_id === 'string' &&
    typeof record.receiver_agent_id === 'string' &&
    typeof record.query === 'string' &&
    typeof record.accepted_text === 'string' &&
    (record.status === 'pending' || record.status === 'completed' || record.status === 'failed') &&
    typeof record.created_at === 'string' &&
    typeof record.updated_at === 'string' &&
    isPersistedScope(record.scope)
  );
}

function isSurfaceNotificationRecord(
  value: unknown,
  surface: SurfaceAsyncChannel
): value is SurfaceNotificationRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.surface === surface &&
    typeof record.notification_id === 'string' &&
    typeof record.channel === 'string' &&
    typeof record.thread_ts === 'string' &&
    typeof record.source_agent_id === 'string' &&
    typeof record.title === 'string' &&
    typeof record.text === 'string' &&
    (record.status === 'info' || record.status === 'success' || record.status === 'error') &&
    typeof record.created_at === 'string' &&
    isPersistedScope(record.scope)
  );
}

function isSurfaceOutboxMessage(
  value: unknown,
  surface: SurfaceAsyncChannel
): value is SurfaceOutboxMessage {
  if (!value || typeof value !== 'object') return false;
  const record = value as unknown as Record<string, unknown>;
  return (
    record.surface === surface &&
    typeof record.message_id === 'string' &&
    record.message_id.length > 0 &&
    typeof record.correlation_id === 'string' &&
    typeof record.channel === 'string' &&
    typeof record.thread_ts === 'string' &&
    typeof record.text === 'string' &&
    (record.source === 'surface' || record.source === 'nerve' || record.source === 'system') &&
    typeof record.created_at === 'string' &&
    isPersistedScope(record.scope) &&
    (record.deduplication_key === undefined ||
      (typeof record.deduplication_key === 'string' && record.deduplication_key.length > 0))
  );
}

function isSurfaceDeadLetterRecord(
  value: unknown,
  surface: SurfaceAsyncChannel
): value is SurfaceDeadLetterRecord {
  if (!isSurfaceOutboxMessage(value, surface)) return false;
  const record = value as unknown as Record<string, unknown>;
  const failure = record.failure;
  if (!failure || typeof failure !== 'object' || Array.isArray(failure)) return false;
  const failureRecord = failure as Record<string, unknown>;
  return (
    record.kind === 'surface-dead-letter' &&
    typeof record.dead_letter_id === 'string' &&
    record.dead_letter_id.length > 0 &&
    typeof record.dead_lettered_at === 'string' &&
    (failureRecord.kind === 'too_long' ||
      failureRecord.kind === 'bad_format' ||
      failureRecord.kind === 'forbidden' ||
      failureRecord.kind === 'not_found' ||
      failureRecord.kind === 'rate_limited' ||
      failureRecord.kind === 'transient') &&
    typeof failureRecord.retryable === 'boolean' &&
    typeof failureRecord.reason === 'string' &&
    failureRecord.reason.length > 0
  );
}

function isSurfaceDeadTargetRecord(
  value: unknown,
  surface: SurfaceAsyncChannel
): value is SurfaceDeadTargetRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const failure = record.failure;
  if (!failure || typeof failure !== 'object' || Array.isArray(failure)) return false;
  const failureRecord = failure as Record<string, unknown>;
  return (
    record.surface === surface &&
    typeof record.channel === 'string' &&
    record.channel.length > 0 &&
    isPersistedScope(record.scope) &&
    Number.isInteger(record.consecutive_failures) &&
    Number(record.consecutive_failures) > 0 &&
    typeof record.marked_at === 'string' &&
    (failureRecord.kind === 'too_long' ||
      failureRecord.kind === 'bad_format' ||
      failureRecord.kind === 'forbidden' ||
      failureRecord.kind === 'not_found' ||
      failureRecord.kind === 'rate_limited' ||
      failureRecord.kind === 'transient') &&
    typeof failureRecord.retryable === 'boolean' &&
    typeof failureRecord.reason === 'string' &&
    failureRecord.reason.length > 0
  );
}

function quarantineSurfaceOutboxFile(
  surface: SurfaceAsyncChannel,
  outboxDir: string,
  fileName: string,
  error: unknown
): void {
  const quarantineDir = path.join(outboxDir, '.quarantine');
  const source = path.join(outboxDir, fileName);
  const quarantineName = `${path.basename(fileName)}.${Date.now().toString(36)}-${randomUUID().slice(0, 8)}.quarantined`;
  const destination = path.join(quarantineDir, quarantineName);
  try {
    withExecutionContext(surfaceCoordinationRole(surface), () => {
      if (!safeExistsSync(quarantineDir)) safeMkdir(quarantineDir, { recursive: true });
      safeMoveSync(source, destination);
    });
    logger.warn(
      `[surface-coordination] quarantined malformed outbox record surface=${surface} file=${fileName}: ${error instanceof Error ? error.message : String(error)}`
    );
  } catch (quarantineError) {
    logger.warn(
      `[surface-coordination] failed to quarantine malformed outbox record surface=${surface} file=${fileName}: ${quarantineError instanceof Error ? quarantineError.message : String(quarantineError)}`
    );
  }
}

function quarantineSurfaceDeadLetterFile(
  surface: SurfaceAsyncChannel,
  deadLetterDir: string,
  fileName: string,
  error: unknown
): void {
  const quarantineDir = path.join(deadLetterDir, '.quarantine');
  const source = path.join(deadLetterDir, fileName);
  const quarantineName = `${path.basename(fileName)}.${Date.now().toString(36)}-${randomUUID().slice(0, 8)}.quarantined`;
  const destination = path.join(quarantineDir, quarantineName);
  try {
    withExecutionContext(surfaceCoordinationRole(surface), () => {
      if (!safeExistsSync(quarantineDir)) safeMkdir(quarantineDir, { recursive: true });
      safeMoveSync(source, destination);
    });
    logger.warn(
      `[surface-coordination] quarantined malformed dead-letter surface=${surface} file=${fileName}: ${error instanceof Error ? error.message : String(error)}`
    );
  } catch (quarantineError) {
    logger.warn(
      `[surface-coordination] failed to quarantine malformed dead-letter surface=${surface} file=${fileName}: ${quarantineError instanceof Error ? quarantineError.message : String(quarantineError)}`
    );
  }
}

function quarantineSurfaceDeadTargetFile(
  surface: SurfaceAsyncChannel,
  deadTargetDir: string,
  fileName: string,
  error: unknown
): void {
  const quarantineDir = path.join(deadTargetDir, '.quarantine');
  const source = path.join(deadTargetDir, fileName);
  const quarantineName = `${path.basename(fileName)}.${Date.now().toString(36)}-${randomUUID().slice(0, 8)}.quarantined`;
  const destination = path.join(quarantineDir, quarantineName);
  try {
    withExecutionContext(surfaceCoordinationRole(surface), () => {
      if (!safeExistsSync(quarantineDir)) safeMkdir(quarantineDir, { recursive: true });
      safeMoveSync(source, destination);
    });
    logger.warn(
      `[surface-coordination] quarantined malformed dead-target surface=${surface} file=${fileName}: ${error instanceof Error ? error.message : String(error)}`
    );
  } catch (quarantineError) {
    logger.warn(
      `[surface-coordination] failed to quarantine malformed dead-target surface=${surface} file=${fileName}: ${quarantineError instanceof Error ? quarantineError.message : String(quarantineError)}`
    );
  }
}

function writeJsonAs(role: GovernedArtifactRole, logicalPath: string, record: unknown): string {
  return writeGovernedArtifactJson(role, logicalPath, record);
}

export function createSurfaceAsyncRequest(params: {
  surface: SurfaceAsyncChannel;
  channel: string;
  threadTs: string;
  senderAgentId: string;
  surfaceAgentId: string;
  receiverAgentId: string;
  query: string;
  acceptedText: string;
  requestId?: string;
  scope?: EventScopeInput;
}): SurfaceAsyncRequestRecord {
  const scope = resolveSurfaceScope(params.scope);
  const request: SurfaceAsyncRequestRecord = {
    request_id:
      params.requestId ||
      `REQ-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 8).toUpperCase()}`,
    surface: params.surface,
    channel: params.channel,
    thread_ts: params.threadTs,
    sender_agent_id: params.senderAgentId,
    surface_agent_id: params.surfaceAgentId,
    receiver_agent_id: params.receiverAgentId,
    query: params.query,
    accepted_text: params.acceptedText,
    status: 'pending',
    created_at: nowIso(),
    updated_at: nowIso(),
    scope,
  };
  writeJsonAs(
    surfaceCoordinationRole(params.surface),
    asyncRequestLogicalPath(params.surface, request.request_id, scope),
    request
  );
  return request;
}

export function getSurfaceAsyncRequest(
  surface: SurfaceAsyncChannel,
  requestId: string,
  scope?: EventScopeInput
): SurfaceAsyncRequestRecord | null {
  const resolved = findRecordPath(asyncRequestBase(surface), requestId, { scope }, 'requests');
  if (!resolved) return null;
  const parsed = loadSurfaceRecordJson<unknown>(resolved);
  if (!isSurfaceAsyncRequestRecord(parsed, surface)) return null;
  const request = parsed;
  return recordMatchesScope(request, scopeFilter(scope)) ? request : null;
}

export function updateSurfaceAsyncRequest(
  surface: SurfaceAsyncChannel,
  requestId: string,
  patch: Partial<SurfaceAsyncRequestRecord>,
  scope?: EventScopeInput
): SurfaceAsyncRequestRecord | null {
  const current = getSurfaceAsyncRequest(surface, requestId, scope);
  if (!current) return null;
  const next: SurfaceAsyncRequestRecord = {
    ...current,
    ...patch,
    request_id: current.request_id,
    surface: current.surface,
    scope: current.scope,
    updated_at: nowIso(),
  };
  writeJsonAs(
    surfaceCoordinationRole(surface),
    asyncRequestLogicalPath(surface, requestId, current.scope),
    next
  );
  return next;
}

export function listSurfaceAsyncRequests(
  surface: SurfaceAsyncChannel,
  options: SurfaceRecordListOptions = {}
): SurfaceAsyncRequestRecord[] {
  const filter = scopeFilter(options.scope);
  return recordFiles(asyncRequestBase(surface), options, 'requests')
    .flatMap((filePath) => {
      try {
        const parsed = loadSurfaceRecordJson<unknown>(filePath);
        if (!isSurfaceAsyncRequestRecord(parsed, surface)) {
          throw new Error('surface async-request schema violation');
        }
        return recordMatchesScope(parsed, filter) ? [parsed] : [];
      } catch (error) {
        quarantineSurfaceRecordFile(
          surface,
          'async-request',
          path.dirname(filePath),
          path.basename(filePath),
          error
        );
        return [];
      }
    })
    .filter((record) => recordMatchesScope(record, filter))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export function enqueueSurfaceNotification(params: {
  surface: SurfaceAsyncChannel;
  channel: string;
  threadTs: string;
  sourceAgentId: string;
  title: string;
  text: string;
  status?: 'info' | 'success' | 'error';
  requestId?: string;
  scope?: EventScopeInput;
}): SurfaceNotificationRecord {
  const scope = resolveSurfaceScope(params.scope);
  const notification: SurfaceNotificationRecord = {
    notification_id: `NTF-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 8).toUpperCase()}`,
    request_id: params.requestId,
    surface: params.surface,
    channel: params.channel,
    thread_ts: params.threadTs,
    source_agent_id: params.sourceAgentId,
    title: params.title,
    text: params.text,
    status: params.status || 'info',
    created_at: nowIso(),
    scope,
  };
  writeJsonAs(
    surfaceCoordinationRole(params.surface),
    surfaceNotificationLogicalPath(params.surface, notification.notification_id, scope),
    notification
  );
  return notification;
}

export function listSurfaceNotifications(
  surface: SurfaceAsyncChannel,
  options: SurfaceRecordListOptions = {}
): SurfaceNotificationRecord[] {
  const filter = scopeFilter(options.scope);
  return recordFiles(notificationBase(surface), options, 'notifications')
    .flatMap((filePath) => {
      try {
        const parsed = loadSurfaceRecordJson<unknown>(filePath);
        if (!isSurfaceNotificationRecord(parsed, surface)) {
          throw new Error('surface notification schema violation');
        }
        return recordMatchesScope(parsed, filter) ? [parsed] : [];
      } catch (error) {
        quarantineSurfaceRecordFile(
          surface,
          'notification',
          path.dirname(filePath),
          path.basename(filePath),
          error
        );
        return [];
      }
    })
    .filter((record) => recordMatchesScope(record, filter))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export function enqueueSurfaceOutboxMessage(params: {
  surface: SurfaceAsyncChannel;
  correlationId: string;
  channel: string;
  threadTs: string;
  text: string;
  source?: 'surface' | 'nerve' | 'system';
  deduplicationKey?: string;
  /** Restore a previously persisted message ID during dead-letter replay. */
  messageId?: string;
  scope?: EventScopeInput;
}): string {
  const scope = resolveSurfaceScope(params.scope);
  const deadTarget = getSurfaceDeadTarget(params.surface, params.channel, scope);
  if (deadTarget) {
    throw new Error(
      `surface_target_dead:${params.surface}:${params.channel}:${deadTarget.failure.kind}`
    );
  }
  const deduplicationKey = params.deduplicationKey?.trim();
  if (deduplicationKey && (deduplicationKey.length > 500 || deduplicationKey.includes('\u0000'))) {
    throw new Error('[POLICY_VIOLATION] Surface outbox deduplication key is invalid.');
  }
  if (deduplicationKey) {
    const existing = listSurfaceOutboxMessages(params.surface, { scope }).find(
      (message) => message.deduplication_key === deduplicationKey
    );
    if (existing)
      return (
        findRecordPath(
          surfaceOutboxBase(params.surface),
          existing.message_id,
          { scope },
          'outbox'
        ) ||
        pathResolver.resolve(surfaceOutboxLogicalPath(params.surface, existing.message_id, scope))
      );
  }
  const messageId =
    params.messageId?.trim() ||
    `${params.surface.toUpperCase()}-OUTBOX-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 8).toUpperCase()}`;
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(messageId)) {
    throw new Error('[POLICY_VIOLATION] Surface outbox message ID is invalid.');
  }
  const record: SurfaceOutboxMessage = {
    message_id: messageId,
    surface: params.surface,
    correlation_id: params.correlationId,
    channel: params.channel,
    thread_ts: params.threadTs,
    text: params.text,
    source: params.source || 'system',
    created_at: nowIso(),
    scope,
    ...(deduplicationKey ? { deduplication_key: deduplicationKey } : {}),
  };
  const outputPath = surfaceOutboxLogicalPath(params.surface, record.message_id, scope);
  const validated = validateSurfaceOutboxMessage(record, outputPath);
  return writeJsonAs(surfaceCoordinationRole(params.surface), outputPath, validated);
}

export function getSurfaceDeadTarget(
  surface: SurfaceAsyncChannel,
  channel: string,
  scope?: EventScopeInput
): SurfaceDeadTargetRecord | null {
  const normalizedScope = resolveSurfaceScope(scope);
  const resolved = pathResolver.resolve(
    surfaceDeadTargetLogicalPath(surface, channel, normalizedScope)
  );
  if (!safeExistsSync(resolved)) return null;
  try {
    const parsed = loadSurfaceRecordJson<unknown>(resolved);
    if (!isSurfaceDeadTargetRecord(parsed, surface)) {
      throw new Error('surface dead-target schema violation');
    }
    return parsed;
  } catch (error) {
    quarantineSurfaceDeadTargetFile(
      surface,
      path.dirname(resolved),
      path.basename(resolved),
      error
    );
    return null;
  }
}

export function markSurfaceDeadTarget(
  surface: SurfaceAsyncChannel,
  channel: string,
  failure: SurfaceDeliveryFailure,
  scope?: EventScopeInput
): SurfaceDeadTargetRecord {
  const normalizedScope = resolveSurfaceScope(scope);
  const current = getSurfaceDeadTarget(surface, channel, normalizedScope);
  const record: SurfaceDeadTargetRecord = {
    surface,
    channel,
    failure,
    scope: normalizedScope,
    consecutive_failures: (current?.consecutive_failures || 0) + 1,
    marked_at: current?.marked_at || nowIso(),
  };
  writeJsonAs(
    surfaceCoordinationRole(surface),
    surfaceDeadTargetLogicalPath(surface, channel, normalizedScope),
    record
  );
  return record;
}

export function clearSurfaceDeadTarget(
  surface: SurfaceAsyncChannel,
  channel: string,
  scope?: EventScopeInput
): void {
  const normalizedScope = resolveSurfaceScope(scope);
  const resolved = pathResolver.resolve(
    surfaceDeadTargetLogicalPath(surface, channel, normalizedScope)
  );
  const safeResolved = assertSafeRepositoryPath(resolved, { allowMissingLeaf: true });
  if (safeExistsSync(safeResolved)) safeRmSync(safeResolved, { force: true });
}

export function listSurfaceDeadTargets(
  surface: SurfaceAsyncChannel,
  options: SurfaceRecordListOptions = {}
): SurfaceDeadTargetRecord[] {
  const filter = scopeFilter(options.scope);
  return recordFiles(surfaceDeadTargetBase(surface), options, 'dead-targets').flatMap(
    (filePath) => {
      const dir = path.dirname(filePath);
      const name = path.basename(filePath);
      try {
        const parsed = loadSurfaceRecordJson<unknown>(filePath);
        if (!isSurfaceDeadTargetRecord(parsed, surface)) {
          throw new Error('surface dead-target schema violation');
        }
        return recordMatchesScope(parsed, filter) ? [parsed] : [];
      } catch (error) {
        quarantineSurfaceDeadTargetFile(surface, dir, name, error);
        return [];
      }
    }
  );
}

export function listSurfaceOutboxMessages(
  surface: SurfaceAsyncChannel,
  options: SurfaceRecordListOptions = {}
): SurfaceOutboxMessage[] {
  const filter = scopeFilter(options.scope);
  return recordFiles(surfaceOutboxBase(surface), options, 'outbox').flatMap((filePath) => {
    const dir = path.dirname(filePath);
    const name = path.basename(filePath);
    try {
      const parsed = loadSurfaceOutboxMessageAtPath(filePath, surface);
      return recordMatchesScope(parsed, filter) ? [parsed] : [];
    } catch (error) {
      quarantineSurfaceOutboxFile(surface, dir, name, error);
      return [];
    }
  });
}

export function clearSurfaceOutboxMessage(
  surface: SurfaceAsyncChannel,
  messageId: string,
  scope?: EventScopeInput
): void {
  if (
    scope &&
    !listSurfaceOutboxMessages(surface, { scope }).some(
      (message) => message.message_id === messageId
    )
  ) {
    return;
  }
  const resolved = findRecordPath(surfaceOutboxBase(surface), messageId, { scope }, 'outbox');
  if (resolved) {
    safeRmSync(assertSafeRepositoryPath(resolved, { allowMissingLeaf: true }), { force: true });
  }
}

export function updateSurfaceOutboxMessage(
  surface: SurfaceAsyncChannel,
  messageId: string,
  patch: Partial<SurfaceOutboxMessage>,
  scope?: EventScopeInput
): SurfaceOutboxMessage | null {
  const current = listSurfaceOutboxMessages(surface, { scope }).find(
    (message) => message.message_id === messageId
  );
  if (!current) return null;
  const next: SurfaceOutboxMessage = {
    ...current,
    ...patch,
    message_id: current.message_id,
    surface: current.surface,
    scope: current.scope,
  };
  const outputPath = surfaceOutboxLogicalPath(surface, messageId, current.scope);
  const validated = validateSurfaceOutboxMessage(next, outputPath);
  writeJsonAs(surfaceCoordinationRole(surface), outputPath, validated);
  return validated;
}

export function deadLetterSurfaceOutboxMessage(
  surface: SurfaceAsyncChannel,
  messageId: string,
  failure: SurfaceDeliveryFailure,
  scope?: EventScopeInput
): SurfaceDeadLetterRecord | null {
  const normalizedScope = scopeFilter(scope);
  const current = listSurfaceOutboxMessages(surface, { scope: normalizedScope }).find(
    (message) => message.message_id === messageId
  );
  if (!current) return null;
  const deadLetter: SurfaceDeadLetterRecord = {
    ...current,
    kind: 'surface-dead-letter',
    dead_letter_id: `${surface.toUpperCase()}-DLQ-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 8).toUpperCase()}`,
    failure,
    dead_lettered_at: nowIso(),
  };
  writeJsonAs(
    surfaceCoordinationRole(surface),
    surfaceDeadLetterLogicalPath(surface, deadLetter.dead_letter_id, current.scope),
    deadLetter
  );
  clearSurfaceOutboxMessage(surface, messageId, current.scope);
  return deadLetter;
}

export function listSurfaceDeadLetters(
  surface: SurfaceAsyncChannel,
  options: SurfaceRecordListOptions = {}
): SurfaceDeadLetterRecord[] {
  const filter = scopeFilter(options.scope);
  return recordFiles(surfaceDeadLetterBase(surface), options, 'dead-letter').flatMap((filePath) => {
    const dir = path.dirname(filePath);
    const name = path.basename(filePath);
    try {
      const parsed = loadSurfaceRecordJson<unknown>(filePath);
      if (!isSurfaceDeadLetterRecord(parsed, surface)) {
        throw new Error('surface dead-letter schema violation');
      }
      return recordMatchesScope(parsed, filter) ? [parsed] : [];
    } catch (error) {
      quarantineSurfaceDeadLetterFile(surface, dir, name, error);
      return [];
    }
  });
}

/**
 * Explicitly requeue one dead-lettered surface message.
 *
 * The dead-letter record remains as an audit trail. A dead-target marker is
 * intentionally not cleared here; an operator must repair and clear the
 * target separately before replaying. Replaying the same record while its
 * new outbox entry is pending is collapsed by the producer dedup key.
 */
export function replaySurfaceDeadLetter(
  surface: SurfaceAsyncChannel,
  deadLetterId: string,
  options: { operatorId: string; deduplicationKey?: string; scope?: EventScopeInput }
): string {
  const operatorId = String(options.operatorId || '').trim();
  if (!operatorId || operatorId.length > 200 || operatorId.includes('\u0000')) {
    throw new Error(
      '[POLICY_VIOLATION] Surface dead-letter replay requires a bounded operator ID.'
    );
  }
  const requestedScope = scopeFilter(options.scope);
  const record = listSurfaceDeadLetters(surface, { scope: requestedScope }).find(
    (candidate) => candidate.dead_letter_id === deadLetterId
  );
  if (!record) {
    throw new Error(`[NOT_FOUND] Surface dead-letter does not exist: ${surface}/${deadLetterId}`);
  }
  if (!isSurfaceOutboxMessage(record, surface)) {
    throw new Error(
      '[POLICY_VIOLATION] Surface dead-letter payload is not a valid outbox message.'
    );
  }
  const recordScope = record.scope || requestedScope;
  if (!recordMatchesScope(record, requestedScope)) {
    throw new Error('[POLICY_VIOLATION] Surface dead-letter scope does not match the caller.');
  }
  if (getSurfaceDeadTarget(surface, record.channel, recordScope)) {
    throw new Error(
      `[POLICY_VIOLATION] Surface target remains marked dead: ${surface}:${record.channel}. Clear the target before replay.`
    );
  }

  const deduplicationKey =
    options.deduplicationKey?.trim() ||
    record.deduplication_key ||
    `surface-replay:${surface}:${deadLetterId}`;
  // Prefer the persisted replay target when this dead letter has already
  // been replayed. This keeps replay idempotent even if the outbox scan used
  // for producer deduplication races with another writer or misses the
  // record during recovery.
  const existingReplay = record.last_replay_message_id
    ? listSurfaceOutboxMessages(surface, { scope: recordScope }).find(
        (message) => message.message_id === record.last_replay_message_id
      )
    : undefined;
  const messagePath = existingReplay
    ? findRecordPath(
        surfaceOutboxBase(surface),
        existingReplay.message_id,
        { scope: recordScope },
        'outbox'
      ) ||
      pathResolver.resolve(
        surfaceOutboxLogicalPath(surface, existingReplay.message_id, recordScope)
      )
    : enqueueSurfaceOutboxMessage({
        surface,
        correlationId: record.correlation_id,
        channel: record.channel,
        threadTs: record.thread_ts,
        text: record.text,
        source: record.source,
        deduplicationKey,
        messageId: record.last_replay_message_id,
        scope: recordScope,
      });
  const messageId = path.basename(messagePath, '.json');
  writeJsonAs(
    surfaceCoordinationRole(surface),
    surfaceDeadLetterLogicalPath(surface, deadLetterId, recordScope),
    {
      ...record,
      replay_count: (record.replay_count || 0) + 1,
      last_replayed_at: nowIso(),
      last_replay_message_id: messageId,
      last_replayed_by: operatorId,
    }
  );
  return messagePath;
}

export function enqueueSlackOutboxMessage(params: {
  correlationId: string;
  channel: string;
  threadTs: string;
  text: string;
  source?: 'surface' | 'nerve' | 'system';
  deduplicationKey?: string;
  scope?: EventScopeInput;
}): string {
  return enqueueSurfaceOutboxMessage({
    surface: 'slack',
    ...params,
  });
}

export function enqueueChronosOutboxMessage(params: {
  correlationId: string;
  channel?: string;
  threadTs: string;
  text: string;
  source?: 'surface' | 'nerve' | 'system';
  deduplicationKey?: string;
  scope?: EventScopeInput;
}): string {
  return enqueueSurfaceOutboxMessage({
    surface: 'chronos',
    correlationId: params.correlationId,
    channel: params.channel || 'chronos',
    threadTs: params.threadTs,
    text: params.text,
    source: params.source,
    deduplicationKey: params.deduplicationKey,
    scope: params.scope,
  });
}

export function listSlackOutboxMessages(
  options: SurfaceRecordListOptions = {}
): SlackOutboxMessage[] {
  return listSurfaceOutboxMessages('slack', options);
}

export function clearSlackOutboxMessage(messageId: string, scope?: EventScopeInput): void {
  clearSurfaceOutboxMessage('slack', messageId, scope);
}

export function appendSurfaceEvent(
  streamLogicalPath: string,
  event: unknown,
  role: GovernedArtifactRole
): string {
  return appendGovernedArtifactJsonl(role, streamLogicalPath, event);
}
