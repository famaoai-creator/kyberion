const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const HYGIENE_REASONS = new Set(['design_missing', 'ready_not_started', 'awaiting_gate']);
const MEMORY_KINDS = new Set(['sop', 'template', 'heuristic', 'risk_rule', 'clarification_prompt']);
const MEMORY_TIERS = new Set(['public', 'confidential', 'personal']);
const RESPONSE_STATES = new Set(['ready', 'waiting', 'queued']);

export type ConciergeResponseStatus = {
  state: 'ready' | 'waiting' | 'queued';
  label: string;
  next_action: string;
  active_count: number;
  queued_count: number;
  stale_child_count: number;
  active_tasks: Array<{
    delegation_id: string;
    mission_id?: string;
    task_id?: string;
    backend_name?: string;
    elapsed_seconds: number;
  }>;
};

export type ConciergeHygieneInquiry = {
  mission_id: string;
  title: string;
  reason: 'design_missing' | 'ready_not_started' | 'awaiting_gate';
  age_days: number | null;
  waiting_since?: string;
};

export type ConciergeMemoryQueueItem = {
  id: string;
  kind: 'sop' | 'template' | 'heuristic' | 'risk_rule' | 'clarification_prompt';
  summary: string;
  source: string;
  source_type: string;
  sensitivity_tier: 'public' | 'confidential' | 'personal';
  occurrences: number;
  queued_at: string;
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasSafeTree(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(hasSafeTree);
  if (!isRecord(value)) return true;
  return Object.entries(value).every(
    ([key, nested]) => !DANGEROUS_KEYS.has(key) && hasSafeTree(nested)
  );
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function optionalString(record: JsonRecord, key: string): boolean {
  return record[key] === undefined || typeof record[key] === 'string';
}

function optionalStringValue(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  return value === undefined ? undefined : (value as string);
}

function validEnvelope(value: unknown, field: string): JsonRecord | undefined {
  if (!isRecord(value) || value.ok !== true || !hasSafeTree(value)) return undefined;
  const nested = value[field];
  return isRecord(nested) ? nested : undefined;
}

function parseActiveTasks(value: unknown): ConciergeResponseStatus['active_tasks'] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tasks: ConciergeResponseStatus['active_tasks'] = [];
  for (const candidate of value) {
    if (
      !isRecord(candidate) ||
      typeof candidate.delegation_id !== 'string' ||
      !optionalString(candidate, 'mission_id') ||
      !optionalString(candidate, 'task_id') ||
      !optionalString(candidate, 'backend_name') ||
      !nonNegativeInteger(candidate.elapsed_seconds)
    ) {
      return undefined;
    }
    const missionId = optionalStringValue(candidate, 'mission_id');
    const taskId = optionalStringValue(candidate, 'task_id');
    const backendName = optionalStringValue(candidate, 'backend_name');
    tasks.push({
      delegation_id: candidate.delegation_id,
      ...(missionId === undefined ? {} : { mission_id: missionId }),
      ...(taskId === undefined ? {} : { task_id: taskId }),
      ...(backendName === undefined ? {} : { backend_name: backendName }),
      elapsed_seconds: candidate.elapsed_seconds,
    });
  }
  return tasks;
}

export function parseConciergeResponseStatusResponse(
  value: unknown
): ConciergeResponseStatus | undefined {
  const record = validEnvelope(value, 'response_status');
  if (
    !record ||
    typeof record.state !== 'string' ||
    !RESPONSE_STATES.has(record.state) ||
    typeof record.label !== 'string' ||
    typeof record.next_action !== 'string' ||
    !nonNegativeInteger(record.active_count) ||
    !nonNegativeInteger(record.queued_count) ||
    !nonNegativeInteger(record.stale_child_count)
  ) {
    return undefined;
  }
  const activeTasks = parseActiveTasks(record.active_tasks);
  if (!activeTasks) return undefined;
  return {
    state: record.state as ConciergeResponseStatus['state'],
    label: record.label,
    next_action: record.next_action,
    active_count: record.active_count,
    queued_count: record.queued_count,
    stale_child_count: record.stale_child_count,
    active_tasks: activeTasks,
  };
}

export function parseConciergeHygieneResponse(
  value: unknown
): ConciergeHygieneInquiry[] | undefined {
  if (
    !isRecord(value) ||
    value.ok !== true ||
    !hasSafeTree(value) ||
    !Array.isArray(value.inquiries)
  ) {
    return undefined;
  }
  const inquiries: ConciergeHygieneInquiry[] = [];
  for (const candidate of value.inquiries) {
    if (
      !isRecord(candidate) ||
      typeof candidate.mission_id !== 'string' ||
      typeof candidate.title !== 'string' ||
      typeof candidate.reason !== 'string' ||
      !HYGIENE_REASONS.has(candidate.reason) ||
      (candidate.age_days !== null && !nonNegativeInteger(candidate.age_days)) ||
      !optionalString(candidate, 'waiting_since')
    ) {
      return undefined;
    }
    const waitingSince = optionalStringValue(candidate, 'waiting_since');
    inquiries.push({
      mission_id: candidate.mission_id,
      title: candidate.title,
      reason: candidate.reason as ConciergeHygieneInquiry['reason'],
      age_days: candidate.age_days as number | null,
      ...(waitingSince === undefined ? {} : { waiting_since: waitingSince }),
    });
  }
  return inquiries;
}

export function parseConciergeMemoryQueueResponse(
  value: unknown
): ConciergeMemoryQueueItem[] | undefined {
  if (
    !isRecord(value) ||
    value.ok !== true ||
    !hasSafeTree(value) ||
    !Array.isArray(value.candidates)
  ) {
    return undefined;
  }
  const candidates: ConciergeMemoryQueueItem[] = [];
  for (const candidate of value.candidates) {
    if (
      !isRecord(candidate) ||
      typeof candidate.id !== 'string' ||
      typeof candidate.kind !== 'string' ||
      !MEMORY_KINDS.has(candidate.kind) ||
      typeof candidate.summary !== 'string' ||
      typeof candidate.source !== 'string' ||
      typeof candidate.source_type !== 'string' ||
      typeof candidate.sensitivity_tier !== 'string' ||
      !MEMORY_TIERS.has(candidate.sensitivity_tier) ||
      !nonNegativeInteger(candidate.occurrences) ||
      candidate.occurrences < 1 ||
      typeof candidate.queued_at !== 'string'
    ) {
      return undefined;
    }
    candidates.push({
      id: candidate.id,
      kind: candidate.kind as ConciergeMemoryQueueItem['kind'],
      summary: candidate.summary,
      source: candidate.source,
      source_type: candidate.source_type,
      sensitivity_tier: candidate.sensitivity_tier as ConciergeMemoryQueueItem['sensitivity_tier'],
      occurrences: candidate.occurrences,
      queued_at: candidate.queued_at,
    });
  }
  return candidates;
}
