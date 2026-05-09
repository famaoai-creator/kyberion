import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile, safeReaddir, safeRmSync } from './secure-io.js';
import { appendGovernedArtifactJsonl, writeGovernedArtifactJson, type GovernedArtifactRole } from './artifact-store.js';
import type {
  SlackOutboxMessage,
  SurfaceAsyncChannel,
  SurfaceAsyncRequestRecord,
  SurfaceNotificationRecord,
  SurfaceOutboxMessage,
} from './channel-surface-types.js';

function surfaceCoordinationRole(surface: SurfaceAsyncChannel): GovernedArtifactRole {
  if (surface === 'slack') return 'slack_bridge';
  if (surface === 'chronos') return 'chronos_gateway';
  return 'surface_runtime';
}

function asyncRequestLogicalPath(surface: SurfaceAsyncChannel, requestId: string): string {
  if (surface === 'presence') {
    return `active/shared/runtime/presence/requests/${requestId}.json`;
  }
  return `active/shared/coordination/channels/${surface}/requests/${requestId}.json`;
}

function surfaceNotificationLogicalPath(surface: SurfaceAsyncChannel, notificationId: string): string {
  if (surface === 'presence') {
    return `active/shared/runtime/presence/notifications/${notificationId}.json`;
  }
  return `active/shared/coordination/channels/${surface}/notifications/${notificationId}.json`;
}

function surfaceOutboxLogicalPath(surface: SurfaceAsyncChannel, messageId: string): string {
  return `active/shared/coordination/channels/${surface}/outbox/${messageId}.json`;
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
    request_id: params.requestId || `REQ-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 8).toUpperCase()}`,
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
  writeJsonAs(surfaceCoordinationRole(params.surface), asyncRequestLogicalPath(params.surface, request.request_id), request);
  return request;
}

export function getSurfaceAsyncRequest(surface: SurfaceAsyncChannel, requestId: string): SurfaceAsyncRequestRecord | null {
  const resolved = pathResolver.resolve(asyncRequestLogicalPath(surface, requestId));
  if (!safeExistsSync(resolved)) return null;
  return JSON.parse(safeReadFile(resolved, { encoding: 'utf8' }) as string) as SurfaceAsyncRequestRecord;
}

export function updateSurfaceAsyncRequest(
  surface: SurfaceAsyncChannel,
  requestId: string,
  patch: Partial<SurfaceAsyncRequestRecord>,
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

export function listSurfaceAsyncRequests(surface: SurfaceAsyncChannel): SurfaceAsyncRequestRecord[] {
  const dir = pathResolver.resolve(
    surface === 'presence'
      ? 'active/shared/runtime/presence/requests'
      : `active/shared/coordination/channels/${surface}/requests`,
  );
  if (!safeExistsSync(dir)) return [];
  return safeReaddir(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(safeReadFile(path.join(dir, name), { encoding: 'utf8' }) as string) as SurfaceAsyncRequestRecord)
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
  writeJsonAs(surfaceCoordinationRole(params.surface), surfaceNotificationLogicalPath(params.surface, notification.notification_id), notification);
  return notification;
}

export function listSurfaceNotifications(surface: SurfaceAsyncChannel): SurfaceNotificationRecord[] {
  const dir = pathResolver.resolve(
    surface === 'presence'
      ? 'active/shared/runtime/presence/notifications'
      : `active/shared/coordination/channels/${surface}/notifications`,
  );
  if (!safeExistsSync(dir)) return [];
  return safeReaddir(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(safeReadFile(path.join(dir, name), { encoding: 'utf8' }) as string) as SurfaceNotificationRecord)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export function enqueueSurfaceOutboxMessage(params: {
  surface: SurfaceAsyncChannel;
  correlationId: string;
  channel: string;
  threadTs: string;
  text: string;
  source?: 'surface' | 'nerve' | 'system';
}): string {
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
  };
  return writeJsonAs(surfaceCoordinationRole(params.surface), surfaceOutboxLogicalPath(params.surface, record.message_id), record);
}

export function listSurfaceOutboxMessages(surface: SurfaceAsyncChannel): SurfaceOutboxMessage[] {
  const dir = pathResolver.resolve(`active/shared/coordination/channels/${surface}/outbox`);
  if (!safeExistsSync(dir)) return [];
  return safeReaddir(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(safeReadFile(path.join(dir, name), { encoding: 'utf8' }) as string) as SurfaceOutboxMessage);
}

export function clearSurfaceOutboxMessage(surface: SurfaceAsyncChannel, messageId: string): void {
  const resolved = pathResolver.resolve(surfaceOutboxLogicalPath(surface, messageId));
  if (!safeExistsSync(resolved)) return;
  safeRmSync(resolved, { force: true });
}

export function enqueueSlackOutboxMessage(params: {
  correlationId: string;
  channel: string;
  threadTs: string;
  text: string;
  source?: 'surface' | 'nerve' | 'system';
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
}): string {
  return enqueueSurfaceOutboxMessage({
    surface: 'chronos',
    correlationId: params.correlationId,
    channel: params.channel || 'chronos',
    threadTs: params.threadTs,
    text: params.text,
    source: params.source,
  });
}

export function listSlackOutboxMessages(): SlackOutboxMessage[] {
  return listSurfaceOutboxMessages('slack');
}

export function clearSlackOutboxMessage(messageId: string): void {
  clearSurfaceOutboxMessage('slack', messageId);
}

export function appendSurfaceEvent(streamLogicalPath: string, event: unknown, role: GovernedArtifactRole): string {
  return appendGovernedArtifactJsonl(role, streamLogicalPath, event);
}
