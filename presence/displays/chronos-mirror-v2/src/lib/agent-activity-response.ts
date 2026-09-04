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

export type ClientAgentActivityBoard = {
  generated_at: string;
  tenant?: string;
  entries: Array<{
    agent_id: string;
    team_role?: string;
    mission_id?: string;
    tenant_slug?: string;
    organization_id?: string;
    project_id?: string;
    task_id?: string;
    work_shape?: string;
    item_id: string;
    title: string;
    status: string;
    phase?: string;
    blockers: Array<{
      kind: 'blocked' | 'dependency' | 'review_wait' | 'unassigned';
      reason: string;
    }>;
    updated_at: string;
  }>;
  agents: Array<{
    agent_id: string;
    active: number;
    blocked: number;
    in_review: number;
  }>;
};

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const BLOCKER_KINDS = new Set(['blocked', 'dependency', 'review_wait', 'unassigned']);

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

function parseBlocker(
  value: unknown
): ClientAgentActivityBoard['entries'][number]['blockers'][number] | undefined {
  if (
    !isRecord(value) ||
    typeof value.kind !== 'string' ||
    !BLOCKER_KINDS.has(value.kind) ||
    !nonEmptyString(value.reason)
  ) {
    return undefined;
  }
  return {
    kind: value.kind as ClientAgentActivityBoard['entries'][number]['blockers'][number]['kind'],
    reason: value.reason,
  };
}

function parseBoardEntry(value: unknown): ClientAgentActivityBoard['entries'][number] | undefined {
  if (
    !isRecord(value) ||
    !nonEmptyString(value.agent_id) ||
    !optionalString(value.team_role) ||
    !optionalString(value.mission_id) ||
    !optionalString(value.tenant_slug) ||
    !optionalString(value.organization_id) ||
    !optionalString(value.project_id) ||
    !optionalString(value.task_id) ||
    !optionalString(value.work_shape) ||
    !nonEmptyString(value.item_id) ||
    !nonEmptyString(value.title) ||
    !nonEmptyString(value.status) ||
    !optionalString(value.phase) ||
    !Array.isArray(value.blockers) ||
    !nonEmptyString(value.updated_at)
  ) {
    return undefined;
  }
  const blockers = value.blockers.map(parseBlocker);
  if (!blockers.every((entry): entry is NonNullable<typeof entry> => entry !== undefined)) {
    return undefined;
  }
  return {
    agent_id: value.agent_id,
    ...(value.team_role !== undefined ? { team_role: value.team_role } : {}),
    ...(value.mission_id !== undefined ? { mission_id: value.mission_id } : {}),
    ...(value.tenant_slug !== undefined ? { tenant_slug: value.tenant_slug } : {}),
    ...(value.organization_id !== undefined ? { organization_id: value.organization_id } : {}),
    ...(value.project_id !== undefined ? { project_id: value.project_id } : {}),
    ...(value.task_id !== undefined ? { task_id: value.task_id } : {}),
    ...(value.work_shape !== undefined ? { work_shape: value.work_shape } : {}),
    item_id: value.item_id,
    title: value.title,
    status: value.status,
    ...(value.phase !== undefined ? { phase: value.phase } : {}),
    blockers,
    updated_at: value.updated_at,
  };
}

function parseBoardAgent(value: unknown): ClientAgentActivityBoard['agents'][number] | undefined {
  if (
    !isRecord(value) ||
    !nonEmptyString(value.agent_id) ||
    !nonNegativeInteger(value.active) ||
    !nonNegativeInteger(value.blocked) ||
    !nonNegativeInteger(value.in_review)
  ) {
    return undefined;
  }
  return {
    agent_id: value.agent_id,
    active: value.active,
    blocked: value.blocked,
    in_review: value.in_review,
  };
}

function parseBoard(value: unknown): ClientAgentActivityBoard | undefined {
  if (!isRecord(value) || !nonEmptyString(value.generated_at) || !optionalString(value.tenant)) {
    return undefined;
  }
  if (!Array.isArray(value.entries) || !Array.isArray(value.agents)) return undefined;
  const entries = value.entries.map(parseBoardEntry);
  const agents = value.agents.map(parseBoardAgent);
  if (
    !entries.every((entry): entry is NonNullable<typeof entry> => entry !== undefined) ||
    !agents.every((entry): entry is NonNullable<typeof entry> => entry !== undefined)
  ) {
    return undefined;
  }
  return {
    generated_at: value.generated_at,
    ...(value.tenant !== undefined ? { tenant: value.tenant } : {}),
    entries,
    agents,
  };
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

export function parseAgentActivityBoardResponse(
  value: unknown
): { board: ClientAgentActivityBoard } | undefined {
  if (!isRecord(value) || !hasSafeTree(value) || value.ok !== true) return undefined;
  const board = parseBoard(value.board);
  return board ? { board } : undefined;
}
