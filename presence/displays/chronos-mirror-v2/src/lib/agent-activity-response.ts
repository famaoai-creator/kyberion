import { isRecord } from '@agent/core/foundation/primitives';

export type ClientAgentActivity = {
  rooms: Array<{
    room_id: string;
    title: string;
    agents: Array<{
      agent_id: string;
      status: string;
      title?: string;
      latest_event?: string;
      pressure?: { severity: string; value: number };
    }>;
  }>;
  attention: Array<{ agent_id: string }>;
  trackRecords: Array<{
    agent_id: string;
    completed_tasks: number;
    review_pass_rate: number;
    rank: string;
  }>;
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

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function nonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function parseAgent(
  value: unknown
): ClientAgentActivity['rooms'][number]['agents'][number] | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !nonEmptyString(value.agent_id) ||
    !nonEmptyString(value.status) ||
    !optionalString(value.title) ||
    !optionalString(value.latest_event)
  ) {
    return undefined;
  }
  if (value.pressure !== undefined) {
    if (
      !isRecord(value.pressure) ||
      !nonEmptyString(value.pressure.severity) ||
      !nonNegativeFinite(value.pressure.value)
    ) {
      return undefined;
    }
  }
  return {
    agent_id: value.agent_id,
    status: value.status,
    ...(value.title !== undefined ? { title: value.title } : {}),
    ...(value.latest_event !== undefined ? { latest_event: value.latest_event } : {}),
    ...(value.pressure !== undefined
      ? { pressure: { severity: value.pressure.severity, value: value.pressure.value } }
      : {}),
  };
}

function parseRoom(value: unknown): ClientAgentActivity['rooms'][number] | undefined {
  if (!isRecord(value) || !nonEmptyString(value.room_id) || !nonEmptyString(value.title)) {
    return undefined;
  }
  if (!Array.isArray(value.agents)) return undefined;
  const agents = value.agents.map(parseAgent);
  return agents.every((entry): entry is NonNullable<typeof entry> => entry !== undefined)
    ? { room_id: value.room_id, title: value.title, agents }
    : undefined;
}

function parseTrackRecord(value: unknown): ClientAgentActivity['trackRecords'][number] | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !nonEmptyString(value.agent_id) ||
    !nonNegativeInteger(value.completed_tasks) ||
    typeof value.review_pass_rate !== 'number' ||
    !Number.isFinite(value.review_pass_rate) ||
    value.review_pass_rate < 0 ||
    value.review_pass_rate > 1 ||
    !nonEmptyString(value.rank)
  ) {
    return undefined;
  }
  return {
    agent_id: value.agent_id,
    completed_tasks: value.completed_tasks,
    review_pass_rate: value.review_pass_rate,
    rank: value.rank,
  };
}

export function parseAgentActivityResponse(value: unknown): ClientAgentActivity | undefined {
  if (
    !isRecord(value) ||
    !hasSafeTree(value) ||
    value.ok !== true ||
    !isRecord(value.office) ||
    !Array.isArray(value.trackRecords)
  ) {
    return undefined;
  }
  const rooms = Array.isArray(value.office.rooms) ? value.office.rooms.map(parseRoom) : null;
  if (!rooms) return undefined;
  if (!rooms.every((entry): entry is NonNullable<typeof entry> => entry !== undefined)) {
    return undefined;
  }
  if (!Array.isArray(value.office.attention)) return undefined;
  const attention = value.office.attention.map((entry) => {
    if (!isRecord(entry) || !nonEmptyString(entry.agent_id)) return undefined;
    return { agent_id: entry.agent_id };
  });
  const trackRecords = value.trackRecords.map(parseTrackRecord);
  if (
    !attention.every((entry): entry is NonNullable<typeof entry> => entry !== undefined) ||
    !trackRecords.every((entry): entry is NonNullable<typeof entry> => entry !== undefined)
  ) {
    return undefined;
  }
  return { rooms, attention, trackRecords };
}
