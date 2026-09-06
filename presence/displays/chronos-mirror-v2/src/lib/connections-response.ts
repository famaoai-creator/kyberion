import { isRecord } from '@agent/core/foundation/primitives';

export type ClientConnectionReviewItem = {
  binding_id: string;
  service_type: string;
  scope: string;
  target: string;
  allowed_actions: string[];
  secret_refs: string[];
  approval_policy: Record<string, 'allowed' | 'approval_required' | 'denied'>;
  tenant_slug?: string;
  project_id?: string;
  service_id?: string;
  auth_mode?: 'none' | 'secret-guard' | 'session';
  metadata?: Record<string, unknown>;
  reviewAction?: 'approve' | 'hold' | 'delete' | 'modify';
  reviewNote?: string;
  reviewedAt?: string;
};

export type ConnectionsResponse = {
  connections: ClientConnectionReviewItem[];
  accessRole: 'readonly' | 'localadmin';
};

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const APPROVAL_STATES = new Set(['allowed', 'approval_required', 'denied']);
const AUTH_MODES = new Set(['none', 'secret-guard', 'session']);
const REVIEW_ACTIONS = new Set(['approve', 'hold', 'delete', 'modify']);

function hasSafeKeys(value: Record<string, unknown>): boolean {
  return Object.entries(value).every(
    ([key, nested]) => !DANGEROUS_KEYS.has(key) && hasSafeNestedKeys(nested)
  );
}

function hasSafeNestedKeys(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(hasSafeNestedKeys);
  return !isRecord(value) || hasSafeKeys(value);
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function parseConnection(value: unknown): ClientConnectionReviewItem | undefined {
  if (!isRecord(value) || !hasSafeKeys(value)) return undefined;
  if (
    typeof value.binding_id !== 'string' ||
    !value.binding_id.trim() ||
    typeof value.service_type !== 'string' ||
    typeof value.scope !== 'string' ||
    typeof value.target !== 'string' ||
    !stringArray(value.allowed_actions) ||
    !stringArray(value.secret_refs) ||
    !isRecord(value.approval_policy) ||
    !hasSafeKeys(value.approval_policy) ||
    Object.values(value.approval_policy).some(
      (state) => typeof state !== 'string' || !APPROVAL_STATES.has(state)
    ) ||
    (value.metadata !== undefined && (!isRecord(value.metadata) || !hasSafeKeys(value.metadata))) ||
    !optionalString(value.tenant_slug) ||
    !optionalString(value.project_id) ||
    !optionalString(value.service_id) ||
    (value.auth_mode !== undefined &&
      (typeof value.auth_mode !== 'string' || !AUTH_MODES.has(value.auth_mode))) ||
    (value.reviewAction !== undefined &&
      (typeof value.reviewAction !== 'string' || !REVIEW_ACTIONS.has(value.reviewAction))) ||
    !optionalString(value.reviewNote) ||
    !optionalString(value.reviewedAt)
  ) {
    return undefined;
  }
  return value as ClientConnectionReviewItem;
}

export function parseConnectionsResponse(value: unknown): ConnectionsResponse | undefined {
  if (!isRecord(value) || !hasSafeKeys(value) || !Array.isArray(value.connections))
    return undefined;
  if (value.accessRole !== 'readonly' && value.accessRole !== 'localadmin') return undefined;
  const connections = value.connections.map(parseConnection);
  return connections.some((entry) => !entry)
    ? undefined
    : { connections: connections as ClientConnectionReviewItem[], accessRole: value.accessRole };
}
