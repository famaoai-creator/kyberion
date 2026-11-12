import { isRecord } from '@agent/core/foundation/primitives';
import type { SurfaceViewerRole } from '@agent/core/surface/surface-authorization';

/**
 * Client-side mirrors of the /api/ops/schedules + /api/ops/pipelines payloads
 * (`lib/ops/pipeline-schedules.ts` `OpsScheduleView` and
 * `lib/ops/pipeline-catalog.ts` `PipelineCatalogEntry`), with the same strict
 * shape checks the other ops response parsers apply — an unparseable payload
 * degrades to `undefined`, never to a partially-typed object.
 */

/** The viewer role (same type as `OpsAccessRole` in `ops-request-guard.ts`; no server import here). */
export type OpsAccessRole = SurfaceViewerRole;

export type ClientScheduleTrigger =
  | { type: 'cron'; cron: string; timezone?: string }
  | { type: 'interval'; intervalMs: number; timezone?: string };

export interface ClientSchedule {
  id: string;
  name: string;
  pipelinePath: string;
  actuator: string;
  trigger: ClientScheduleTrigger;
  enabled: boolean;
  optIn?: boolean;
  managedBy?: string;
  lastRun?: string;
  lastStatus?: 'succeeded' | 'failed';
  consecutiveFailures?: number;
  disabledReason?: string;
  /** Fires on the next scheduler tick right now. */
  dueNow: boolean;
  /** Enabled but excluded by this host's operator schedule allowlist. */
  operatorExcluded: boolean;
}

export interface ClientPipeline {
  path: string;
  name: string;
  description: string;
  version?: string;
  ops: string[];
  stepCount: number;
  hasSchedule: boolean;
  notPipeline?: boolean;
  parseError?: boolean;
}

export interface SchedulesResponse {
  schedules: ClientSchedule[];
  accessRole: OpsAccessRole;
}

export interface PipelinesResponse {
  pipelines: ClientPipeline[];
  accessRole: OpsAccessRole;
}

export interface RunDispatch {
  resourceId: string;
  pipelinePath: string;
}

type JsonRecord = Record<string, unknown>;
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function safeOptionalString(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  return value === undefined ? undefined : typeof value === 'string' ? value : undefined;
}

function clean(value: unknown): value is JsonRecord {
  return isRecord(value) && !Object.keys(value).some((key) => DANGEROUS_KEYS.has(key));
}

function parseTrigger(value: unknown): ClientScheduleTrigger | undefined {
  if (!clean(value)) return undefined;
  const timezone = safeOptionalString(value, 'timezone');
  if (value.timezone !== undefined && timezone === undefined) return undefined;
  const base = timezone ? { timezone } : {};
  if (value.type === 'cron') {
    return typeof value.cron === 'string' && value.cron.trim()
      ? { type: 'cron', cron: value.cron, ...base }
      : undefined;
  }
  if (value.type === 'interval') {
    const intervalMs = value.intervalMs;
    return typeof intervalMs === 'number' && Number.isFinite(intervalMs)
      ? { type: 'interval', intervalMs, ...base }
      : undefined;
  }
  return undefined;
}

function parseSchedule(value: unknown): ClientSchedule | undefined {
  if (!clean(value)) return undefined;
  const required = ['id', 'name', 'pipelinePath', 'actuator'] as const;
  const strings = Object.fromEntries(
    required.map((key) => [
      key,
      typeof value[key] === 'string' && value[key].trim() ? value[key] : undefined,
    ])
  ) as Record<(typeof required)[number], string | undefined>;
  if (required.some((key) => !strings[key])) return undefined;
  const optionalKeys = ['managedBy', 'lastRun', 'disabledReason'] as const;
  const optionalStrings = Object.fromEntries(
    optionalKeys.map((key) => [key, safeOptionalString(value, key)])
  ) as Record<(typeof optionalKeys)[number], string | undefined>;
  if (optionalKeys.some((key) => value[key] !== undefined && optionalStrings[key] === undefined))
    return undefined;
  const trigger = parseTrigger(value.trigger);
  if (!trigger) return undefined;
  if (typeof value.enabled !== 'boolean') return undefined;
  if (typeof value.dueNow !== 'boolean' || typeof value.operatorExcluded !== 'boolean')
    return undefined;
  const lastStatus = value.lastStatus;
  if (lastStatus !== undefined && lastStatus !== 'succeeded' && lastStatus !== 'failed')
    return undefined;
  const consecutiveFailures = value.consecutiveFailures;
  if (
    consecutiveFailures !== undefined &&
    (typeof consecutiveFailures !== 'number' || !Number.isFinite(consecutiveFailures))
  )
    return undefined;
  if (value.optIn !== undefined && typeof value.optIn !== 'boolean') return undefined;
  return {
    id: strings.id!,
    name: strings.name!,
    pipelinePath: strings.pipelinePath!,
    actuator: strings.actuator!,
    trigger,
    enabled: value.enabled as boolean,
    dueNow: value.dueNow as boolean,
    operatorExcluded: value.operatorExcluded as boolean,
    ...optionalStrings,
    ...(lastStatus !== undefined ? { lastStatus: lastStatus as 'succeeded' | 'failed' } : {}),
    ...(consecutiveFailures !== undefined
      ? { consecutiveFailures: consecutiveFailures as number }
      : {}),
    ...(value.optIn !== undefined ? { optIn: value.optIn as boolean } : {}),
  };
}

function parsePipeline(value: unknown): ClientPipeline | undefined {
  if (!clean(value)) return undefined;
  const path = value.path;
  const name = value.name;
  const description = value.description;
  const stepCount = value.stepCount;
  if (typeof path !== 'string' || !path.trim()) return undefined;
  if (typeof name !== 'string' || !name.trim()) return undefined;
  if (typeof description !== 'string') return undefined;
  if (typeof stepCount !== 'number' || !Number.isFinite(stepCount) || stepCount < 0)
    return undefined;
  if (typeof value.hasSchedule !== 'boolean') return undefined;
  const ops = value.ops;
  if (!Array.isArray(ops) || ops.some((op) => typeof op !== 'string')) return undefined;
  if (value.version !== undefined && typeof value.version !== 'string') return undefined;
  if (value.notPipeline !== undefined && typeof value.notPipeline !== 'boolean') return undefined;
  if (value.parseError !== undefined && typeof value.parseError !== 'boolean') return undefined;
  return {
    path,
    name,
    description,
    ops: ops as string[],
    stepCount,
    hasSchedule: value.hasSchedule as boolean,
    ...(value.version !== undefined ? { version: value.version as string } : {}),
    ...(value.notPipeline !== undefined ? { notPipeline: value.notPipeline as boolean } : {}),
    ...(value.parseError !== undefined ? { parseError: value.parseError as boolean } : {}),
  };
}

function parseAccessRole(value: unknown): OpsAccessRole | undefined {
  return value === 'readonly' || value === 'localadmin' ? value : undefined;
}

export function parseSchedulesResponse(value: unknown): SchedulesResponse | undefined {
  if (!clean(value) || !Array.isArray(value.schedules)) return undefined;
  const schedules = value.schedules.map(parseSchedule);
  if (schedules.some((entry) => !entry)) return undefined;
  const accessRole = parseAccessRole(value.accessRole);
  if (!accessRole) return undefined;
  return { schedules: schedules as ClientSchedule[], accessRole };
}

export function parsePipelinesResponse(value: unknown): PipelinesResponse | undefined {
  if (!clean(value) || !Array.isArray(value.pipelines)) return undefined;
  const pipelines = value.pipelines.map(parsePipeline);
  if (pipelines.some((entry) => !entry)) return undefined;
  const accessRole = parseAccessRole(value.accessRole);
  if (!accessRole) return undefined;
  return { pipelines: pipelines as ClientPipeline[], accessRole };
}

export function parseRunDispatchResponse(value: unknown): RunDispatch | undefined {
  if (!clean(value)) return undefined;
  const run = value.run ?? value;
  if (!clean(run)) return undefined;
  const resourceId = run.resourceId;
  const pipelinePath = run.pipelinePath;
  if (typeof resourceId !== 'string' || !resourceId.trim()) return undefined;
  if (typeof pipelinePath !== 'string' || !pipelinePath.trim()) return undefined;
  return { resourceId, pipelinePath };
}

/** `{ok:false, error}` from a mutation route — the message the server sent. */
export function readApiError(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  const error = body.error;
  return typeof error === 'string' && error.trim() ? error : undefined;
}
