import { isRecord } from '@agent/core/foundation/primitives';

export type ClientDiagnosticsPayload = {
  activeMissions: Array<{
    missionId: string;
    status: string;
    nextTaskCount: number;
  }>;
  runtimeDoctor: Array<{
    agentId: string;
    reason: string;
    severity: 'warning' | 'critical';
  }>;
  surfaces: Array<{
    id: string;
    health: string;
    controlSummary: string;
  }>;
  recentSurfaceOutbox: Array<{
    message_id: string;
    surface: string;
    text: string;
  }>;
};

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const SEVERITIES = new Set(['warning', 'critical']);

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

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function parseMission(
  value: unknown
): ClientDiagnosticsPayload['activeMissions'][number] | undefined {
  if (
    !isRecord(value) ||
    !nonEmptyString(value.missionId) ||
    !nonEmptyString(value.status) ||
    !nonNegativeInteger(value.nextTaskCount)
  ) {
    return undefined;
  }
  return {
    missionId: value.missionId,
    status: value.status,
    nextTaskCount: value.nextTaskCount,
  };
}

function parseRuntimeFinding(
  value: unknown
): ClientDiagnosticsPayload['runtimeDoctor'][number] | undefined {
  if (
    !isRecord(value) ||
    !nonEmptyString(value.agentId) ||
    !nonEmptyString(value.reason) ||
    typeof value.severity !== 'string' ||
    !SEVERITIES.has(value.severity)
  ) {
    return undefined;
  }
  return {
    agentId: value.agentId,
    reason: value.reason,
    severity: value.severity as 'warning' | 'critical',
  };
}

function parseSurface(value: unknown): ClientDiagnosticsPayload['surfaces'][number] | undefined {
  if (
    !isRecord(value) ||
    !nonEmptyString(value.id) ||
    !nonEmptyString(value.health) ||
    !nonEmptyString(value.controlSummary)
  ) {
    return undefined;
  }
  return {
    id: value.id,
    health: value.health,
    controlSummary: value.controlSummary,
  };
}

function parseOutboxMessage(
  value: unknown
): ClientDiagnosticsPayload['recentSurfaceOutbox'][number] | undefined {
  if (
    !isRecord(value) ||
    !nonEmptyString(value.message_id) ||
    !nonEmptyString(value.surface) ||
    !nonEmptyString(value.text)
  ) {
    return undefined;
  }
  return {
    message_id: value.message_id,
    surface: value.surface,
    text: value.text,
  };
}

function parseArray<T>(value: unknown, parser: (entry: unknown) => T | undefined): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = value.map(parser);
  return entries.every((entry): entry is T => entry !== undefined) ? entries : undefined;
}

export function parseDiagnosticsResponse(value: unknown): ClientDiagnosticsPayload | undefined {
  if (!isRecord(value) || !hasSafeTree(value)) return undefined;
  const activeMissions = parseArray(value.activeMissions, parseMission);
  const runtimeDoctor = parseArray(value.runtimeDoctor, parseRuntimeFinding);
  const surfaces = parseArray(value.surfaces, parseSurface);
  const recentSurfaceOutbox = parseArray(value.recentSurfaceOutbox, parseOutboxMessage);
  if (!activeMissions || !runtimeDoctor || !surfaces || !recentSurfaceOutbox) return undefined;
  return { activeMissions, runtimeDoctor, surfaces, recentSurfaceOutbox };
}
