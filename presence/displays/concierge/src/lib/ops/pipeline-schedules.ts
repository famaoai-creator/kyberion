import {
  isScheduledPipelineDue,
  listOperatorExcludedSchedules,
  listScheduledPipelines,
  normalizeScheduledPipelinePath,
  registerScheduledPipeline,
  runnerDerivedContextKeys,
  unregisterScheduledPipeline,
  type ScheduledPipeline,
} from '@agent/core/pipeline/pipeline-scheduler';
import { pathResolver } from '@agent/core/path-resolver';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat } from '@agent/core/secure-io';

/**
 * Concierge projection of the governed pipeline-schedule registry
 * (libs/core/pipeline/pipeline-scheduler.ts). Terminal-hud already mutates the
 * same registry; this module adds only request-shape validation + the UI
 * projection — never a second store.
 */

export interface OpsScheduleView {
  id: string;
  name: string;
  pipelinePath: string;
  actuator: string;
  trigger: ScheduledPipeline['trigger'];
  enabled: boolean;
  optIn?: boolean;
  managedBy?: string;
  lastRun?: string;
  lastStatus?: 'succeeded' | 'failed';
  consecutiveFailures?: number;
  disabledReason?: string;
  /** Fires on the next tick right now (respects enabled, allowlist, run lock). */
  dueNow: boolean;
  /** Enabled but kept from running by this host's KYBERION_CHRONOS_SCHEDULES. */
  operatorExcluded: boolean;
  deliverTo?: ScheduledPipeline['deliver_to'];
  context?: Record<string, unknown>;
}

export interface ScheduleMutationInput {
  id?: unknown;
  name?: unknown;
  pipelinePath?: unknown;
  actuator?: unknown;
  trigger?: unknown;
  enabled?: unknown;
  context?: unknown;
  deliver_to?: unknown;
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const TRIGGER_TYPES = new Set(['cron', 'interval']);

export class ScheduleInputError extends Error {}

function asTrimmedString(value: unknown, field: string, { required = true } = {}): string {
  if (value === undefined || value === null) {
    if (required) throw new ScheduleInputError(`${field} is required`);
    return '';
  }
  if (typeof value !== 'string') throw new ScheduleInputError(`${field} must be a string`);
  const trimmed = value.trim();
  if (required && !trimmed) throw new ScheduleInputError(`${field} is required`);
  return trimmed;
}

/** Repo-relative path under pipelines/ that exists and is a regular .json file. */
export function assertRunnablePipelinePath(rawPath: string): string {
  let normalized: string;
  try {
    normalized = normalizeScheduledPipelinePath(rawPath);
  } catch {
    throw new ScheduleInputError('pipelinePath must be repo-relative and inside the repo root');
  }
  const relative = normalized.replace(/\\/g, '/');
  if (relative.split('/').includes('..')) {
    throw new ScheduleInputError('pipelinePath must not contain .. segments');
  }
  const pipelinesPrefix = 'pipelines/';
  if (!relative.startsWith(pipelinesPrefix)) {
    throw new ScheduleInputError('pipelinePath must live under pipelines/');
  }
  if (relative.startsWith('pipelines/fragments/')) {
    throw new ScheduleInputError('pipelinePath must not point at a shared fragment');
  }
  if (!relative.endsWith('.json')) {
    throw new ScheduleInputError('pipelinePath must be a .json pipeline file');
  }
  const absolute = assertSafeRepositoryPath(pathResolver.rootResolve(relative), {
    allowMissingLeaf: true,
  });
  if (!safeExistsSync(absolute) || !safeLstat(absolute).isFile()) {
    throw new ScheduleInputError(`pipeline file not found: ${relative}`);
  }
  return relative;
}

const TENANT_PATH_PATTERN = /^knowledge\/(?:confidential|personal)\/([^/]+)\//u;
const TENANT_ID_PATTERN = /^tenant-([a-z0-9][a-z0-9-]*)-/u;

/**
 * Tenant slug a schedule is bound to, if any: either its pipeline lives under
 * a tenant knowledge floor or the registry sync stamped it `tenant-<slug>-*`.
 * Anything else is a shared system schedule visible to every operator.
 */
export function scheduleTenantSlug(
  schedule: Pick<ScheduledPipeline, 'id' | 'pipelinePath'>
): string | undefined {
  const fromPath = schedule.pipelinePath.replace(/\\/g, '/').match(TENANT_PATH_PATTERN)?.[1];
  return fromPath ?? schedule.id.match(TENANT_ID_PATTERN)?.[1];
}

/** Tenant-bound entries are visible only inside their tenant scope (or 'all'). */
export function scheduleAdmitsTenantScope(
  schedule: Pick<ScheduledPipeline, 'id' | 'pipelinePath'>,
  tenantSlugs: readonly string[] | 'all'
): boolean {
  const slug = scheduleTenantSlug(schedule);
  if (!slug) return true;
  return tenantSlugs === 'all' || tenantSlugs.includes(slug);
}

/**
 * A schedule of a catalog pipeline (`pipelines/…`) runs repository-wide ADF
 * whatever its id says: only a schedule whose pipeline lives under a tenant
 * knowledge floor is confined to that tenant. Registering, changing or running
 * a catalog schedule therefore needs repository-wide access
 * (`opsViewerMayActRepositoryWide`), not just a tenant scope that admits it.
 */
export function scheduleRunsCatalogPipeline(
  schedule: Pick<ScheduledPipeline, 'pipelinePath'>
): boolean {
  return !TENANT_PATH_PATTERN.test(schedule.pipelinePath.replace(/\\/g, '/'));
}

export function parseScheduleTrigger(raw: unknown): ScheduledPipeline['trigger'] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ScheduleInputError('trigger must be an object');
  }
  const input = raw as Record<string, unknown>;
  const type = asTrimmedString(input.type, 'trigger.type');
  if (!TRIGGER_TYPES.has(type)) {
    throw new ScheduleInputError('trigger.type must be cron or interval');
  }
  const timezone = asTrimmedString(input.timezone, 'trigger.timezone', { required: false });
  if (timezone) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    } catch {
      throw new ScheduleInputError(`trigger.timezone is not a valid IANA zone: ${timezone}`);
    }
  }
  if (type === 'cron') {
    const cron = asTrimmedString(input.cron, 'trigger.cron');
    if (cron.split(/\s+/u).length !== 5) {
      throw new ScheduleInputError('trigger.cron must be a 5-field cron expression');
    }
    return { type: 'cron', cron, ...(timezone ? { timezone } : {}) };
  }
  const intervalMs = Number(input.intervalMs);
  if (!Number.isFinite(intervalMs) || intervalMs < 60_000) {
    throw new ScheduleInputError('trigger.intervalMs must be a number ≥ 60000');
  }
  return { type: 'interval', intervalMs, ...(timezone ? { timezone } : {}) };
}

function parseDeliverTo(raw: unknown): ScheduledPipeline['deliver_to'] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ScheduleInputError('deliver_to must be an object');
  }
  const input = raw as Record<string, unknown>;
  const surface = asTrimmedString(input.surface, 'deliver_to.surface');
  const channel = asTrimmedString(input.channel, 'deliver_to.channel');
  const thread = asTrimmedString(input.thread_ts, 'deliver_to.thread_ts', { required: false });
  const template = asTrimmedString(input.template, 'deliver_to.template', { required: false });
  return {
    surface,
    channel,
    ...(thread ? { thread_ts: thread } : {}),
    ...(template ? { template } : {}),
  };
}

function parseContext(raw: unknown): Record<string, unknown> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ScheduleInputError('context must be an object');
  }
  const reserved = runnerDerivedContextKeys(raw as Record<string, unknown>);
  if (reserved.length > 0) {
    throw new ScheduleInputError(
      `context must not set runner-derived keys: ${reserved.join(', ')}`
    );
  }
  return raw as Record<string, unknown>;
}

export function toOpsScheduleView(
  schedule: ScheduledPipeline,
  excluded: readonly string[],
  now = new Date()
): OpsScheduleView {
  return {
    id: schedule.id,
    name: schedule.name,
    pipelinePath: schedule.pipelinePath,
    actuator: schedule.actuator,
    trigger: schedule.trigger,
    enabled: schedule.enabled,
    ...(schedule.optIn ? { optIn: schedule.optIn } : {}),
    ...(schedule.managedBy ? { managedBy: schedule.managedBy } : {}),
    ...(schedule.lastRun ? { lastRun: schedule.lastRun } : {}),
    ...(schedule.lastStatus ? { lastStatus: schedule.lastStatus } : {}),
    ...(schedule.consecutiveFailures ? { consecutiveFailures: schedule.consecutiveFailures } : {}),
    ...(schedule.disabledReason ? { disabledReason: schedule.disabledReason } : {}),
    dueNow: isScheduledPipelineDue(schedule, schedule.trigger.timezone, now),
    operatorExcluded: excluded.includes(schedule.id),
    ...(schedule.deliver_to ? { deliverTo: schedule.deliver_to } : {}),
    ...(schedule.context ? { context: schedule.context } : {}),
  };
}

export function listOpsSchedules(
  now = new Date(),
  tenantSlugs: readonly string[] | 'all' = 'all'
): OpsScheduleView[] {
  const schedules = listScheduledPipelines().filter((schedule) =>
    scheduleAdmitsTenantScope(schedule, tenantSlugs)
  );
  const excluded = listOperatorExcludedSchedules(schedules);
  return schedules
    .map((schedule) => toOpsScheduleView(schedule, excluded, now))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Out-of-scope ids resolve to undefined so reads/mutations answer 404. */
export function findOpsSchedule(
  id: string,
  tenantSlugs: readonly string[] | 'all' = 'all'
): ScheduledPipeline | undefined {
  return listScheduledPipelines().find(
    (schedule) => schedule.id === id && scheduleAdmitsTenantScope(schedule, tenantSlugs)
  );
}

/** Fields accepted on register; on update, omitted fields keep their values. */
export function parseScheduleMutation(
  input: ScheduleMutationInput,
  existing?: ScheduledPipeline
): ScheduledPipeline {
  const id = asTrimmedString(input.id ?? existing?.id, 'id');
  if (!ID_PATTERN.test(id)) {
    throw new ScheduleInputError('id must be alphanumeric with . _ : - only');
  }
  const name =
    asTrimmedString(input.name ?? existing?.name, 'name', { required: !existing }) ||
    existing?.name ||
    id;
  // The file-existence check only applies to a path being set — toggling
  // enabled or renaming must still work when the target file was removed.
  const pipelinePath = input.pipelinePath
    ? assertRunnablePipelinePath(asTrimmedString(input.pipelinePath, 'pipelinePath'))
    : normalizeScheduledPipelinePath(asTrimmedString(existing?.pipelinePath, 'pipelinePath'));
  const actuator =
    asTrimmedString(input.actuator ?? existing?.actuator, 'actuator', {
      required: !existing,
    }) ||
    existing?.actuator ||
    'system';
  const trigger =
    input.trigger !== undefined ? parseScheduleTrigger(input.trigger) : existing?.trigger;
  if (!trigger) throw new ScheduleInputError('trigger is required');
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    throw new ScheduleInputError('enabled must be a boolean');
  }
  const enabled = input.enabled !== undefined ? input.enabled : (existing?.enabled ?? true);
  return {
    ...(existing ?? {}),
    id,
    name,
    pipelinePath,
    actuator,
    trigger,
    enabled,
    ...(input.context !== undefined || existing?.context
      ? { context: parseContext(input.context) ?? existing?.context }
      : {}),
    ...(input.deliver_to !== undefined || existing?.deliver_to
      ? { deliver_to: parseDeliverTo(input.deliver_to) ?? existing?.deliver_to }
      : {}),
  } as ScheduledPipeline;
}

export function registerOpsSchedule(
  input: ScheduleMutationInput,
  existing?: ScheduledPipeline
): OpsScheduleView {
  const schedule = parseScheduleMutation(input, existing);
  registerScheduledPipeline(schedule);
  const excluded = listOperatorExcludedSchedules([schedule]);
  return toOpsScheduleView(schedule, excluded);
}

export function unregisterOpsSchedule(
  id: string,
  tenantSlugs: readonly string[] | 'all' = 'all'
): boolean {
  const found = findOpsSchedule(id, tenantSlugs);
  if (!found) return false;
  unregisterScheduledPipeline(id);
  return true;
}
