import { randomUUID } from 'node:crypto';

import { appendGovernedArtifactJsonl, type GovernedArtifactRole } from './artifact-store.js';
import { normalizeEventScope, type EventScope, type EventScopeInput } from './event-scope.js';
import { getProtocolServiceRegistryEntry } from './protocol-service-registry.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';

export type ProtocolServiceLifecycleAction =
  'start' | 'stop' | 'reconnect' | 'restore' | 'restore_quarantine' | 'health_check';

export type ProtocolServiceLifecycleStatus =
  | 'started'
  | 'stopped'
  | 'reconnected'
  | 'restored'
  | 'quarantined'
  | 'healthy'
  | 'unhealthy'
  | 'failed';

export interface ProtocolServiceLifecycleReceipt {
  kind: 'protocol-service-lifecycle-receipt.v1';
  receipt_id: string;
  service_id: string;
  action: ProtocolServiceLifecycleAction;
  status: ProtocolServiceLifecycleStatus;
  occurred_at: string;
  scope: EventScope;
  actor_role: GovernedArtifactRole;
  requested_by?: string;
  principal?: { kind: 'nhi' | 'human' | 'service'; id: string };
  correlation_id?: string;
  reason?: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface RecordProtocolServiceLifecycleInput {
  serviceId: string;
  action: ProtocolServiceLifecycleAction;
  status: ProtocolServiceLifecycleStatus;
  scope: EventScopeInput;
  actorRole?: GovernedArtifactRole;
  requestedBy?: string;
  principal?: ProtocolServiceLifecycleReceipt['principal'];
  correlationId?: string;
  reason?: string;
  metadata?: Record<string, string | number | boolean | null>;
  occurredAt?: string | Date;
  receiptId?: string;
}

const LIFECYCLE_ROOT = 'active/shared/observability/protocol-services';

function iso(value?: string | Date): string {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) throw new Error('[PROTOCOL_LIFECYCLE_INVALID_TIMESTAMP]');
  return date.toISOString();
}

function safeSegment(value: string, label: string): string {
  const normalized = String(value || '').trim();
  if (!normalized || !/^[a-zA-Z0-9._-]+$/u.test(normalized)) {
    throw new Error(`[PROTOCOL_LIFECYCLE_INVALID_${label.toUpperCase()}]`);
  }
  return normalized;
}

function lifecycleLogicalPath(serviceId: string, scope: EventScope): string {
  const serviceSegment = safeSegment(serviceId, 'service_id');
  const scopeSegment = scope.tenant_slug
    ? `tenants/${safeSegment(scope.tenant_slug, 'tenant')}`
    : 'system';
  return `${LIFECYCLE_ROOT}/${serviceSegment}/${scopeSegment}/lifecycle.jsonl`;
}

export function protocolServiceLifecycleLogicalPath(
  serviceId: string,
  scopeInput: EventScopeInput
): string {
  getProtocolServiceRegistryEntry(serviceId);
  return lifecycleLogicalPath(serviceId, normalizeEventScope(scopeInput));
}

export function recordProtocolServiceLifecycle(
  input: RecordProtocolServiceLifecycleInput
): ProtocolServiceLifecycleReceipt {
  const registryEntry = getProtocolServiceRegistryEntry(input.serviceId);
  if (!registryEntry.lifecycle_actions.includes(input.action)) {
    throw new Error(
      `[PROTOCOL_LIFECYCLE_ACTION_NOT_REGISTERED] ${registryEntry.id}:${input.action}`
    );
  }
  const scope = normalizeEventScope(input.scope);
  const actorRole = input.actorRole || 'infrastructure_sentinel';
  const receipt: ProtocolServiceLifecycleReceipt = {
    kind: 'protocol-service-lifecycle-receipt.v1',
    receipt_id: input.receiptId || `psl-${randomUUID()}`,
    service_id: registryEntry.id,
    action: input.action,
    status: input.status,
    occurred_at: iso(input.occurredAt),
    scope,
    actor_role: actorRole,
    ...(input.requestedBy ? { requested_by: input.requestedBy } : {}),
    ...(input.principal ? { principal: input.principal } : {}),
    ...(input.correlationId ? { correlation_id: input.correlationId } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
  appendGovernedArtifactJsonl(actorRole, lifecycleLogicalPath(registryEntry.id, scope), receipt);
  return receipt;
}

export function readProtocolServiceLifecycleReceipts(
  serviceId: string,
  scopeInput: EventScopeInput
): ProtocolServiceLifecycleReceipt[] {
  const logicalPath = protocolServiceLifecycleLogicalPath(serviceId, scopeInput);
  const absolutePath = pathResolver.resolve(logicalPath);
  if (!safeExistsSync(absolutePath)) return [];
  const lines = String(safeReadFile(absolutePath, { encoding: 'utf8' }) || '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.map((line) => JSON.parse(line) as ProtocolServiceLifecycleReceipt);
}
