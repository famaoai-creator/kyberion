import { isRecord } from '@agent/core/foundation/primitives';

export type ClientAgentSpawnResponse = {
  status: 'spawned';
  agent: Record<string, unknown>;
};

export type ClientAgentRefreshResponse =
  | {
      status: 'ok';
      agentId: string;
      refreshed: boolean;
      reason: string;
    }
  | {
      status: 'ok';
      agentId: string;
      mode: string;
      snapshot?: Record<string, unknown>;
    };

export type ClientAgentRestartResponse = {
  status: 'ok';
  agentId: string;
  snapshot?: Record<string, unknown>;
  agent?: Record<string, unknown>;
};

export type ClientAgentShutdownResponse = {
  status: 'shutdown';
  agentId: string;
};

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function hasSafeTree(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(hasSafeTree);
  if (!isRecord(value)) return true;
  return Object.entries(value).every(
    ([key, nested]) => !DANGEROUS_KEYS.has(key) && hasSafeTree(nested)
  );
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim());
}

function safeRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && hasSafeTree(value);
}

export function parseAgentSpawnResponse(value: unknown): ClientAgentSpawnResponse | undefined {
  if (!safeRecord(value) || value.status !== 'spawned' || !safeRecord(value.agent)) {
    return undefined;
  }
  return { status: 'spawned', agent: value.agent };
}

export function parseAgentRefreshResponse(value: unknown): ClientAgentRefreshResponse | undefined {
  if (!safeRecord(value) || value.status !== 'ok' || !nonEmptyString(value.agentId)) {
    return undefined;
  }
  if (
    typeof value.refreshed === 'boolean' &&
    typeof value.reason === 'string' &&
    value.mode === undefined &&
    value.snapshot === undefined
  ) {
    return {
      status: 'ok',
      agentId: value.agentId,
      refreshed: value.refreshed,
      reason: value.reason,
    };
  }
  if (
    nonEmptyString(value.mode) &&
    (value.snapshot === undefined || safeRecord(value.snapshot)) &&
    value.refreshed === undefined &&
    value.reason === undefined
  ) {
    return {
      status: 'ok',
      agentId: value.agentId,
      mode: value.mode,
      ...(value.snapshot !== undefined ? { snapshot: value.snapshot } : {}),
    };
  }
  return undefined;
}

export function parseAgentRestartResponse(value: unknown): ClientAgentRestartResponse | undefined {
  if (
    !safeRecord(value) ||
    value.status !== 'ok' ||
    !nonEmptyString(value.agentId) ||
    (value.snapshot !== undefined && !safeRecord(value.snapshot)) ||
    (value.agent !== undefined && !safeRecord(value.agent)) ||
    (value.snapshot === undefined && value.agent === undefined)
  ) {
    return undefined;
  }
  return {
    status: 'ok',
    agentId: value.agentId,
    ...(value.snapshot !== undefined ? { snapshot: value.snapshot } : {}),
    ...(value.agent !== undefined ? { agent: value.agent } : {}),
  };
}

export function parseAgentShutdownResponse(
  value: unknown
): ClientAgentShutdownResponse | undefined {
  if (!safeRecord(value) || value.status !== 'shutdown' || !nonEmptyString(value.agentId)) {
    return undefined;
  }
  return { status: 'shutdown', agentId: value.agentId };
}
