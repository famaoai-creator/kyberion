import { isRecord } from '@agent/core/foundation/primitives';

export type ClientAgentLogEntry = {
  ts: number;
  type: string;
  content: string;
};

export type ClientAgentLogsResponse = {
  status: 'ok';
  agentId: string;
  logs: ClientAgentLogEntry[];
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

function parseLogEntry(value: unknown): ClientAgentLogEntry | undefined {
  if (
    !isRecord(value) ||
    typeof value.ts !== 'number' ||
    !Number.isFinite(value.ts) ||
    value.ts < 0 ||
    !nonEmptyString(value.type) ||
    typeof value.content !== 'string'
  ) {
    return undefined;
  }
  return { ts: value.ts, type: value.type, content: value.content };
}

export function parseAgentLogsResponse(value: unknown): ClientAgentLogsResponse | undefined {
  if (
    !isRecord(value) ||
    !hasSafeTree(value) ||
    value.status !== 'ok' ||
    !nonEmptyString(value.agentId) ||
    !Array.isArray(value.logs)
  ) {
    return undefined;
  }
  const logs = value.logs.map(parseLogEntry);
  if (!logs.every((entry): entry is NonNullable<typeof entry> => entry !== undefined)) {
    return undefined;
  }
  return { status: 'ok', agentId: value.agentId, logs };
}
