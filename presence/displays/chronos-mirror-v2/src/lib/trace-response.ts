import type { OsKnowledgeTier } from '@agent/core/cloudflare-os-control-plane';

export type TraceStatus = 'ok' | 'error' | 'in_progress';
export type TraceArtifactType = 'screenshot' | 'file' | 'document' | 'log';

export type TraceFeedRecord = {
  traceId: string;
  tracePath: string;
  persistedAt: string;
  startedAt: string;
  completedAt?: string;
  missionId?: string;
  tenantSlug?: string;
  tier?: OsKnowledgeTier;
  organizationId?: string;
  projectId?: string;
  pipelineId?: string;
  actuator?: string;
  status: TraceStatus;
  rootSpanName: string;
  spanCount: number;
  eventCount: number;
  artifactCount: number;
  errorCount: number;
  rootSpan: {
    spanId?: string;
    name: string;
    status: TraceStatus;
    startTime: string;
    endTime?: string;
    attributes?: Record<string, string | number | boolean>;
    events: number;
    artifacts: number;
    children: number;
  };
};

export type TraceSpanDetail = {
  spanId?: string;
  name: string;
  status: TraceStatus;
  startTime: string;
  endTime?: string;
  attributes?: Record<string, string | number | boolean>;
  events: Array<{
    name: string;
    timestamp: string;
    attributes?: Record<string, string | number | boolean>;
  }>;
  artifacts: Array<{
    type: TraceArtifactType;
    path: string;
    description?: string;
    timestamp: string;
  }>;
  knowledgeRefs: string[];
  error?: string;
  children: TraceSpanDetail[];
};

export type TraceDetailRecord = Omit<TraceFeedRecord, 'rootSpan'> & {
  rootSpan: TraceSpanDetail;
};

export type TraceFeedResponse = {
  traces: TraceFeedRecord[];
  traceDir: string;
};

export type TraceDetailResponse = {
  trace: TraceDetailRecord | null;
  traceDir: string;
};

type JsonRecord = Record<string, unknown>;

const STATUSES: readonly TraceStatus[] = ['ok', 'error', 'in_progress'];
const TIERS: readonly OsKnowledgeTier[] = ['public', 'confidential', 'personal'];
const ARTIFACT_TYPES: readonly TraceArtifactType[] = ['screenshot', 'file', 'document', 'log'];
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeRecord(value: unknown): JsonRecord | undefined {
  if (!isRecord(value)) return undefined;
  if (Object.keys(value).some((key) => DANGEROUS_KEYS.has(key))) return undefined;
  return value;
}

function requiredString(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function optionalString(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  return value === undefined ? undefined : typeof value === 'string' ? value : undefined;
}

function requiredNumber(record: JsonRecord, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && allowed.includes(value as T) ? (value as T) : undefined;
}

function parseAttributes(value: unknown): Record<string, string | number | boolean> | undefined {
  if (value === undefined) return undefined;
  const record = safeRecord(value);
  if (!record) return undefined;
  const output: Record<string, string | number | boolean> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (
      typeof entry !== 'string' &&
      typeof entry !== 'boolean' &&
      !(typeof entry === 'number' && Number.isFinite(entry))
    ) {
      return undefined;
    }
    output[key] = entry;
  }
  return output;
}

function parseSummarySpan(value: unknown): TraceFeedRecord['rootSpan'] | undefined {
  const record = safeRecord(value);
  if (!record) return undefined;
  const name = requiredString(record, 'name');
  const status = enumValue(record.status, STATUSES);
  const startTime = requiredString(record, 'startTime');
  const events = requiredNumber(record, 'events');
  const artifacts = requiredNumber(record, 'artifacts');
  const children = requiredNumber(record, 'children');
  if (
    !name ||
    !status ||
    !startTime ||
    events === undefined ||
    artifacts === undefined ||
    children === undefined
  )
    return undefined;
  const attributes = parseAttributes(record.attributes);
  if (record.attributes !== undefined && !attributes) return undefined;
  const spanId = optionalString(record, 'spanId');
  const endTime = optionalString(record, 'endTime');
  if (record.spanId !== undefined && spanId === undefined) return undefined;
  if (record.endTime !== undefined && endTime === undefined) return undefined;
  return {
    name,
    status,
    startTime,
    events,
    artifacts,
    children,
    ...(spanId ? { spanId } : {}),
    ...(endTime ? { endTime } : {}),
    ...(attributes ? { attributes } : {}),
  };
}

function parseFeedRecord(value: unknown): TraceFeedRecord | undefined {
  const record = safeRecord(value);
  if (!record) return undefined;
  const traceId = requiredString(record, 'traceId');
  const tracePath = requiredString(record, 'tracePath');
  const persistedAt = requiredString(record, 'persistedAt');
  const startedAt = requiredString(record, 'startedAt');
  const status = enumValue(record.status, STATUSES);
  const rootSpanName = requiredString(record, 'rootSpanName');
  const counts = ['spanCount', 'eventCount', 'artifactCount', 'errorCount'].map((key) =>
    requiredNumber(record, key)
  );
  const rootSpan = parseSummarySpan(record.rootSpan);
  if (
    !traceId ||
    !tracePath ||
    !persistedAt ||
    !startedAt ||
    !status ||
    !rootSpanName ||
    !rootSpan ||
    counts.some((value) => value === undefined)
  )
    return undefined;
  const optionalFields = {
    completedAt: optionalString(record, 'completedAt'),
    missionId: optionalString(record, 'missionId'),
    tenantSlug: optionalString(record, 'tenantSlug'),
    tier: enumValue(record.tier, TIERS),
    organizationId: optionalString(record, 'organizationId'),
    projectId: optionalString(record, 'projectId'),
    pipelineId: optionalString(record, 'pipelineId'),
    actuator: optionalString(record, 'actuator'),
  };
  for (const key of [
    'completedAt',
    'missionId',
    'tenantSlug',
    'organizationId',
    'projectId',
    'pipelineId',
    'actuator',
  ]) {
    if (
      record[key] !== undefined &&
      optionalFields[key as keyof typeof optionalFields] === undefined
    )
      return undefined;
  }
  if (record.tier !== undefined && optionalFields.tier === undefined) return undefined;
  return {
    traceId,
    tracePath,
    persistedAt,
    startedAt,
    status,
    rootSpanName,
    spanCount: counts[0]!,
    eventCount: counts[1]!,
    artifactCount: counts[2]!,
    errorCount: counts[3]!,
    rootSpan,
    ...optionalFields,
  };
}

function parseSpanDetail(value: unknown): TraceSpanDetail | undefined {
  const record = safeRecord(value);
  if (!record) return undefined;
  const name = requiredString(record, 'name');
  const status = enumValue(record.status, STATUSES);
  const startTime = requiredString(record, 'startTime');
  const events = Array.isArray(record.events) ? record.events : undefined;
  const artifacts = Array.isArray(record.artifacts) ? record.artifacts : undefined;
  const knowledgeRefs = Array.isArray(record.knowledgeRefs) ? record.knowledgeRefs : undefined;
  const children = Array.isArray(record.children) ? record.children : undefined;
  if (!name || !status || !startTime || !events || !artifacts || !knowledgeRefs || !children)
    return undefined;
  const parsedEvents = events.map((value) => {
    const entry = safeRecord(value);
    if (!entry) return undefined;
    const eventName = requiredString(entry, 'name');
    const timestamp = requiredString(entry, 'timestamp');
    const attributes = parseAttributes(entry.attributes);
    if (!eventName || !timestamp || (entry.attributes !== undefined && !attributes))
      return undefined;
    return { name: eventName, timestamp, ...(attributes ? { attributes } : {}) };
  });
  const parsedArtifacts = artifacts.map((value) => {
    const entry = safeRecord(value);
    if (!entry) return undefined;
    const type = enumValue(entry.type, ARTIFACT_TYPES);
    const path = requiredString(entry, 'path');
    const timestamp = requiredString(entry, 'timestamp');
    const description = optionalString(entry, 'description');
    if (
      !type ||
      !path ||
      !timestamp ||
      (entry.description !== undefined && description === undefined)
    )
      return undefined;
    return { type, path, timestamp, ...(description ? { description } : {}) };
  });
  const parsedChildren = children.map(parseSpanDetail);
  if (
    parsedEvents.some((entry) => !entry) ||
    parsedArtifacts.some((entry) => !entry) ||
    parsedChildren.some((entry) => !entry) ||
    knowledgeRefs.some((entry) => typeof entry !== 'string')
  )
    return undefined;
  const attributes = parseAttributes(record.attributes);
  const spanId = optionalString(record, 'spanId');
  const endTime = optionalString(record, 'endTime');
  const error = optionalString(record, 'error');
  if (
    (record.attributes !== undefined && !attributes) ||
    (record.spanId !== undefined && spanId === undefined) ||
    (record.endTime !== undefined && endTime === undefined) ||
    (record.error !== undefined && error === undefined)
  )
    return undefined;
  return {
    name,
    status,
    startTime,
    events: parsedEvents as TraceSpanDetail['events'],
    artifacts: parsedArtifacts as TraceSpanDetail['artifacts'],
    knowledgeRefs: knowledgeRefs as string[],
    children: parsedChildren as TraceSpanDetail[],
    ...(spanId ? { spanId } : {}),
    ...(endTime ? { endTime } : {}),
    ...(error ? { error } : {}),
    ...(attributes ? { attributes } : {}),
  };
}

function parseDetailRecord(value: unknown): TraceDetailRecord | undefined {
  const raw = safeRecord(value);
  if (!raw) return undefined;
  const rawRoot = safeRecord(raw.rootSpan);
  if (!rawRoot) return undefined;
  // The feed summary and detail endpoints share the envelope, but their
  // rootSpan projections intentionally differ (counts vs. child arrays).
  // Validate the shared envelope with a count-neutral view, then validate the
  // complete detail span recursively below.
  const record = parseFeedRecord({
    ...raw,
    rootSpan: {
      ...rawRoot,
      events: typeof rawRoot.events === 'number' ? rawRoot.events : 0,
      artifacts: typeof rawRoot.artifacts === 'number' ? rawRoot.artifacts : 0,
      children: typeof rawRoot.children === 'number' ? rawRoot.children : 0,
    },
  });
  if (!record) return undefined;
  const rootSpan = parseSpanDetail(raw.rootSpan);
  return rootSpan ? { ...record, rootSpan } : undefined;
}

export function parseTraceFeedResponse(value: unknown): TraceFeedResponse | undefined {
  const record = safeRecord(value);
  if (!record || !Array.isArray(record.traces) || typeof record.traceDir !== 'string')
    return undefined;
  const traces = record.traces.map(parseFeedRecord);
  return traces.every((trace): trace is TraceFeedRecord => Boolean(trace))
    ? { traces, traceDir: record.traceDir }
    : undefined;
}

export function parseTraceDetailResponse(value: unknown): TraceDetailResponse | undefined {
  const record = safeRecord(value);
  if (!record || typeof record.traceDir !== 'string') return undefined;
  if (record.trace === null) return { trace: null, traceDir: record.traceDir };
  const trace = parseDetailRecord(record.trace);
  return trace ? { trace, traceDir: record.traceDir } : undefined;
}
