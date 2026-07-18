import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import { pathResolver } from './path-resolver.js';
import { withExecutionContext } from './authority.js';
import { logger } from './core.js';
import {
  safeExistsSync,
  safeMkdir,
  safeMoveSync,
  safeReadFile,
  safeReaddir,
  safeRmSync,
} from './secure-io.js';
import {
  appendGovernedArtifactJsonl,
  writeGovernedArtifactJson,
  type GovernedArtifactRole,
} from './artifact-store.js';
import { getSurfaceCoordinationRole } from './surface-coordination-role-map.js';
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

function surfaceCoordinationRole(surface: SurfaceAsyncChannel): GovernedArtifactRole {
  return getSurfaceCoordinationRole(surface);
}

function asyncRequestLogicalPath(surface: SurfaceAsyncChannel, requestId: string): string {
  if (surface === 'presence') {
    return `active/shared/runtime/presence/requests/${requestId}.json`;
  }
  return `active/shared/coordination/channels/${surface}/requests/${requestId}.json`;
}

function surfaceNotificationLogicalPath(
  surface: SurfaceAsyncChannel,
  notificationId: string
): string {
  if (surface === 'presence') {
    return `active/shared/runtime/presence/notifications/${notificationId}.json`;
  }
  return `active/shared/coordination/channels/${surface}/notifications/${notificationId}.json`;
}

function surfaceOutboxLogicalPath(surface: SurfaceAsyncChannel, messageId: string): string {
  return `active/shared/coordination/channels/${surface}/outbox/${messageId}.json`;
}

function surfaceDeadLetterLogicalPath(surface: SurfaceAsyncChannel, deadLetterId: string): string {
  return `active/shared/coordination/channels/${surface}/dead-letter/${deadLetterId}.json`;
}

function surfaceDeadLetterLogicalDir(surface: SurfaceAsyncChannel): string {
  return `active/shared/coordination/channels/${surface}/dead-letter`;
}

function surfaceDeadLetterQuarantineLogicalDir(surface: SurfaceAsyncChannel): string {
  return `${surfaceDeadLetterLogicalDir(surface)}/.quarantine`;
}

function surfaceDeadTargetLogicalPath(surface: SurfaceAsyncChannel, channel: string): string {
  const key = createHash('sha256').update(channel).digest('hex').slice(0, 32);
  return `active/shared/coordination/channels/${surface}/dead-targets/${key}.json`;
}

function surfaceDeadTargetLogicalDir(surface: SurfaceAsyncChannel): string {
  return `active/shared/coordination/channels/${surface}/dead-targets`;
}

function surfaceDeadTargetQuarantineLogicalDir(surface: SurfaceAsyncChannel): string {
  return `${surfaceDeadTargetLogicalDir(surface)}/.quarantine`;
}

function surfaceOutboxLogicalDir(surface: SurfaceAsyncChannel): string {
  return `active/shared/coordination/channels/${surface}/outbox`;
}

function surfaceOutboxQuarantineLogicalDir(surface: SurfaceAsyncChannel): string {
  return `${surfaceOutboxLogicalDir(surface)}/.quarantine`;
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
  const quarantineDir = pathResolver.resolve(surfaceOutboxQuarantineLogicalDir(surface));
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
  const quarantineDir = pathResolver.resolve(surfaceDeadLetterQuarantineLogicalDir(surface));
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
  const quarantineDir = pathResolver.resolve(surfaceDeadTargetQuarantineLogicalDir(surface));
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
}): SurfaceAsyncRequestRecord {
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
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  writeJsonAs(
    surfaceCoordinationRole(params.surface),
    asyncRequestLogicalPath(params.surface, request.request_id),
    request
  );
  return request;
}

export function getSurfaceAsyncRequest(
  surface: SurfaceAsyncChannel,
  requestId: string
): SurfaceAsyncRequestRecord | null {
  const resolved = pathResolver.resolve(asyncRequestLogicalPath(surface, requestId));
  if (!safeExistsSync(resolved)) return null;
  return JSON.parse(
    safeReadFile(resolved, { encoding: 'utf8' }) as string
  ) as SurfaceAsyncRequestRecord;
}

export function updateSurfaceAsyncRequest(
  surface: SurfaceAsyncChannel,
  requestId: string,
  patch: Partial<SurfaceAsyncRequestRecord>
): SurfaceAsyncRequestRecord | null {
  const current = getSurfaceAsyncRequest(surface, requestId);
  if (!current) return null;
  const next: SurfaceAsyncRequestRecord = {
    ...current,
    ...patch,
    request_id: current.request_id,
    surface: current.surface,
    updated_at: new Date().toISOString(),
  };
  writeJsonAs(surfaceCoordinationRole(surface), asyncRequestLogicalPath(surface, requestId), next);
  return next;
}

export function listSurfaceAsyncRequests(
  surface: SurfaceAsyncChannel
): SurfaceAsyncRequestRecord[] {
  const dir = pathResolver.resolve(
    surface === 'presence'
      ? 'active/shared/runtime/presence/requests'
      : `active/shared/coordination/channels/${surface}/requests`
  );
  if (!safeExistsSync(dir)) return [];
  return safeReaddir(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map(
      (name) =>
        JSON.parse(
          safeReadFile(path.join(dir, name), { encoding: 'utf8' }) as string
        ) as SurfaceAsyncRequestRecord
    )
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
}): SurfaceNotificationRecord {
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
    created_at: new Date().toISOString(),
  };
  writeJsonAs(
    surfaceCoordinationRole(params.surface),
    surfaceNotificationLogicalPath(params.surface, notification.notification_id),
    notification
  );
  return notification;
}

export function listSurfaceNotifications(
  surface: SurfaceAsyncChannel
): SurfaceNotificationRecord[] {
  const dir = pathResolver.resolve(
    surface === 'presence'
      ? 'active/shared/runtime/presence/notifications'
      : `active/shared/coordination/channels/${surface}/notifications`
  );
  if (!safeExistsSync(dir)) return [];
  return safeReaddir(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map(
      (name) =>
        JSON.parse(
          safeReadFile(path.join(dir, name), { encoding: 'utf8' }) as string
        ) as SurfaceNotificationRecord
    )
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
}): string {
  const deadTarget = getSurfaceDeadTarget(params.surface, params.channel);
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
    const existing = listSurfaceOutboxMessages(params.surface).find(
      (message) => message.deduplication_key === deduplicationKey
    );
    if (existing)
      return pathResolver.resolve(surfaceOutboxLogicalPath(params.surface, existing.message_id));
  }
  const surfacePrefix = params.surface.toUpperCase();
  const record: SurfaceOutboxMessage = {
    message_id: `${surfacePrefix}-OUTBOX-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 8).toUpperCase()}`,
    surface: params.surface,
    correlation_id: params.correlationId,
    channel: params.channel,
    thread_ts: params.threadTs,
    text: params.text,
    source: params.source || 'system',
    created_at: new Date().toISOString(),
    ...(deduplicationKey ? { deduplication_key: deduplicationKey } : {}),
  };
  return writeJsonAs(
    surfaceCoordinationRole(params.surface),
    surfaceOutboxLogicalPath(params.surface, record.message_id),
    record
  );
}

export function getSurfaceDeadTarget(
  surface: SurfaceAsyncChannel,
  channel: string
): SurfaceDeadTargetRecord | null {
  const resolved = pathResolver.resolve(surfaceDeadTargetLogicalPath(surface, channel));
  if (!safeExistsSync(resolved)) return null;
  try {
    const parsed = JSON.parse(safeReadFile(resolved, { encoding: 'utf8' }) as string);
    if (!isSurfaceDeadTargetRecord(parsed, surface)) {
      throw new Error('surface dead-target schema violation');
    }
    return parsed;
  } catch (error) {
    quarantineSurfaceDeadTargetFile(
      surface,
      pathResolver.resolve(surfaceDeadTargetLogicalDir(surface)),
      path.basename(resolved),
      error
    );
    return null;
  }
}

export function markSurfaceDeadTarget(
  surface: SurfaceAsyncChannel,
  channel: string,
  failure: SurfaceDeliveryFailure
): SurfaceDeadTargetRecord {
  const current = getSurfaceDeadTarget(surface, channel);
  const record: SurfaceDeadTargetRecord = {
    surface,
    channel,
    failure,
    consecutive_failures: (current?.consecutive_failures || 0) + 1,
    marked_at: current?.marked_at || new Date().toISOString(),
  };
  writeJsonAs(
    surfaceCoordinationRole(surface),
    surfaceDeadTargetLogicalPath(surface, channel),
    record
  );
  return record;
}

export function clearSurfaceDeadTarget(surface: SurfaceAsyncChannel, channel: string): void {
  const resolved = pathResolver.resolve(surfaceDeadTargetLogicalPath(surface, channel));
  if (safeExistsSync(resolved)) safeRmSync(resolved, { force: true });
}

export function listSurfaceDeadTargets(surface: SurfaceAsyncChannel): SurfaceDeadTargetRecord[] {
  const dir = pathResolver.resolve(surfaceDeadTargetLogicalDir(surface));
  if (!safeExistsSync(dir)) return [];
  return safeReaddir(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .flatMap((name) => {
      try {
        const parsed = JSON.parse(
          safeReadFile(path.join(dir, name), { encoding: 'utf8' }) as string
        );
        if (!isSurfaceDeadTargetRecord(parsed, surface)) {
          throw new Error('surface dead-target schema violation');
        }
        return [parsed];
      } catch (error) {
        quarantineSurfaceDeadTargetFile(surface, dir, name, error);
        return [];
      }
    });
}

export function listSurfaceOutboxMessages(surface: SurfaceAsyncChannel): SurfaceOutboxMessage[] {
  const dir = pathResolver.resolve(surfaceOutboxLogicalDir(surface));
  if (!safeExistsSync(dir)) return [];
  return safeReaddir(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .flatMap((name) => {
      try {
        const parsed = JSON.parse(
          safeReadFile(path.join(dir, name), { encoding: 'utf8' }) as string
        );
        if (!isSurfaceOutboxMessage(parsed, surface)) {
          throw new Error('surface outbox schema violation');
        }
        return [parsed];
      } catch (error) {
        quarantineSurfaceOutboxFile(surface, dir, name, error);
        return [];
      }
    });
}

export function clearSurfaceOutboxMessage(surface: SurfaceAsyncChannel, messageId: string): void {
  const resolved = pathResolver.resolve(surfaceOutboxLogicalPath(surface, messageId));
  if (!safeExistsSync(resolved)) return;
  safeRmSync(resolved, { force: true });
}

export function updateSurfaceOutboxMessage(
  surface: SurfaceAsyncChannel,
  messageId: string,
  patch: Partial<SurfaceOutboxMessage>
): SurfaceOutboxMessage | null {
  const current = listSurfaceOutboxMessages(surface).find(
    (message) => message.message_id === messageId
  );
  if (!current) return null;
  const next: SurfaceOutboxMessage = {
    ...current,
    ...patch,
    message_id: current.message_id,
    surface: current.surface,
  };
  writeJsonAs(surfaceCoordinationRole(surface), surfaceOutboxLogicalPath(surface, messageId), next);
  return next;
}

export function deadLetterSurfaceOutboxMessage(
  surface: SurfaceAsyncChannel,
  messageId: string,
  failure: SurfaceDeliveryFailure
): SurfaceDeadLetterRecord | null {
  const current = listSurfaceOutboxMessages(surface).find(
    (message) => message.message_id === messageId
  );
  if (!current) return null;
  const deadLetter: SurfaceDeadLetterRecord = {
    ...current,
    kind: 'surface-dead-letter',
    dead_letter_id: `${surface.toUpperCase()}-DLQ-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 8).toUpperCase()}`,
    failure,
    dead_lettered_at: new Date().toISOString(),
  };
  writeJsonAs(
    surfaceCoordinationRole(surface),
    surfaceDeadLetterLogicalPath(surface, deadLetter.dead_letter_id),
    deadLetter
  );
  clearSurfaceOutboxMessage(surface, messageId);
  return deadLetter;
}

export function listSurfaceDeadLetters(surface: SurfaceAsyncChannel): SurfaceDeadLetterRecord[] {
  const dir = pathResolver.resolve(surfaceDeadLetterLogicalDir(surface));
  if (!safeExistsSync(dir)) return [];
  return safeReaddir(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .flatMap((name) => {
      try {
        const parsed = JSON.parse(
          safeReadFile(path.join(dir, name), { encoding: 'utf8' }) as string
        );
        if (!isSurfaceDeadLetterRecord(parsed, surface)) {
          throw new Error('surface dead-letter schema violation');
        }
        return [parsed];
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
  options: { operatorId: string; deduplicationKey?: string }
): string {
  const operatorId = String(options.operatorId || '').trim();
  if (!operatorId || operatorId.length > 200 || operatorId.includes('\u0000')) {
    throw new Error(
      '[POLICY_VIOLATION] Surface dead-letter replay requires a bounded operator ID.'
    );
  }
  const record = listSurfaceDeadLetters(surface).find(
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
  if (getSurfaceDeadTarget(surface, record.channel)) {
    throw new Error(
      `[POLICY_VIOLATION] Surface target remains marked dead: ${surface}:${record.channel}. Clear the target before replay.`
    );
  }

  const deduplicationKey =
    options.deduplicationKey?.trim() ||
    record.deduplication_key ||
    `surface-replay:${surface}:${deadLetterId}`;
  const messagePath = enqueueSurfaceOutboxMessage({
    surface,
    correlationId: record.correlation_id,
    channel: record.channel,
    threadTs: record.thread_ts,
    text: record.text,
    source: record.source,
    deduplicationKey,
  });
  const messageId = path.basename(messagePath, '.json');
  writeJsonAs(
    surfaceCoordinationRole(surface),
    surfaceDeadLetterLogicalPath(surface, deadLetterId),
    {
      ...record,
      replay_count: (record.replay_count || 0) + 1,
      last_replayed_at: new Date().toISOString(),
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
}): string {
  return enqueueSurfaceOutboxMessage({
    surface: 'chronos',
    correlationId: params.correlationId,
    channel: params.channel || 'chronos',
    threadTs: params.threadTs,
    text: params.text,
    source: params.source,
    deduplicationKey: params.deduplicationKey,
  });
}

export function listSlackOutboxMessages(): SlackOutboxMessage[] {
  return listSurfaceOutboxMessages('slack');
}

export function clearSlackOutboxMessage(messageId: string): void {
  clearSurfaceOutboxMessage('slack', messageId);
}

export function appendSurfaceEvent(
  streamLogicalPath: string,
  event: unknown,
  role: GovernedArtifactRole
): string {
  return appendGovernedArtifactJsonl(role, streamLogicalPath, event);
}
