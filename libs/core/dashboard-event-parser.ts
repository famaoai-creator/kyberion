import { isRecord } from './foundation/text.js';
import { parseSafeJsonInput } from './foundation/json.js';
import { nowIso } from './foundation/time.js';

export interface DashboardOrchestrationEvent {
  ts: string;
  decision: string;
  mission?: string;
  why?: string;
}

export interface DashboardOwnerSummary {
  ts: string;
  mission_id: string;
  accepted_count: number;
  reviewed_count: number;
  completed_count: number;
  requested_count: number;
}

function parseTimestamp(value: unknown): string | undefined {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : undefined;
}

function parseCount(value: unknown): number {
  if (value === undefined) return 0;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : -1;
}

export function parseDashboardJsonRecord(line: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = parseSafeJsonInput(line, 'dashboard event');
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function parseDashboardOrchestrationEvent(
  value: unknown,
  fallbackTimestamp = nowIso()
): DashboardOrchestrationEvent | undefined {
  if (!isRecord(value)) return undefined;
  const ts = value.ts === undefined ? fallbackTimestamp : parseTimestamp(value.ts);
  const decisionValue = value.decision ?? value.event_type;
  const decision =
    typeof decisionValue === 'string' && decisionValue.trim() ? decisionValue.trim() : 'event';
  if (!ts || !Number.isFinite(Date.parse(ts))) return undefined;
  const missionValue = value.mission_id ?? value.resource_id;
  const mission =
    typeof missionValue === 'string' && missionValue.trim() ? missionValue : undefined;
  const why = typeof value.why === 'string' ? value.why : undefined;
  return { ts, decision, ...(mission ? { mission } : {}), ...(why ? { why } : {}) };
}

export function parseDashboardOwnerSummary(value: unknown): DashboardOwnerSummary | undefined {
  if (!isRecord(value)) return undefined;
  const decision = value.decision ?? value.event_type;
  const ts = parseTimestamp(value.ts);
  const missionId = value.mission_id;
  const counts = {
    accepted_count: parseCount(value.accepted_count),
    reviewed_count: parseCount(value.reviewed_count),
    completed_count: parseCount(value.completed_count),
    requested_count: parseCount(value.requested_count),
  };
  if (
    decision !== 'mission_owner_notified' ||
    !ts ||
    typeof missionId !== 'string' ||
    !missionId.trim() ||
    Object.values(counts).some((count) => count < 0)
  ) {
    return undefined;
  }
  return { ts, mission_id: missionId, ...counts };
}

export function parseDashboardOrchestrationLine(
  line: string
): DashboardOrchestrationEvent | undefined {
  const record = parseDashboardJsonRecord(line);
  return record ? parseDashboardOrchestrationEvent(record) : undefined;
}

export function parseDashboardOwnerSummaryLine(line: string): DashboardOwnerSummary | undefined {
  const record = parseDashboardJsonRecord(line);
  return record ? parseDashboardOwnerSummary(record) : undefined;
}
