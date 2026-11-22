/** Shared persistence and inspection contract for continuous cadence. */
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { DotCharter } from '@agent/core/dot/dot-charter';
import { dotStatePath } from '@agent/core/dot/dot-state-paths';
import type { ContinuousOperationsConfig } from '@agent/core/organization/continuous-operations-policy';
import { parseSafeJsonInput } from '@agent/core/foundation/safe-json';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeReadFileSnapshot } from '@agent/core/secure-io';

type CadenceReader = (file: string) => unknown;
export function matches(charter: DotCharter, config: ContinuousOperationsConfig): boolean {
  return (
    charter.status === 'active' &&
    charter.dot_id === config.dot_id &&
    charter.scope.tier === config.scope.tier &&
    charter.scope.tenant_slug === config.scope.tenant_slug &&
    charter.scope.organization_id === config.scope.organization_id &&
    charter.scope.project_id === config.scope.project_id
  );
}

export function stateFile(
  root: string,
  charter: DotCharter,
  config: ContinuousOperationsConfig
): string {
  const identity = createHash('sha256')
    .update(JSON.stringify({ loop: config.loop_id, scope: config.scope, dot: config.dot_id }))
    .digest('hex');
  return path.join(root, dotStatePath(charter, `continuous-cadence-${identity}.json`));
}

export interface CadenceCheckpoint {
  version: 1;
  last_run_at: string;
  last_success_at?: string;
  last_observation_at?: string;
  last_admission_error_count?: number;
  last_admission_held?: boolean;
  collector_held?: boolean;
  last_withheld_sources?: string[];
}

function parseCheckpoint(value: unknown): CadenceCheckpoint {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid continuous cadence state');
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    Object.keys(record).some(
      (key) =>
        ![
          'version',
          'last_run_at',
          'last_success_at',
          'last_observation_at',
          'last_admission_error_count',
          'last_admission_held',
          'collector_held',
          'last_withheld_sources',
        ].includes(key)
    ) ||
    typeof record.last_run_at !== 'string' ||
    !Number.isFinite(Date.parse(record.last_run_at)) ||
    (record.last_withheld_sources !== undefined &&
      (!Array.isArray(record.last_withheld_sources) ||
        record.last_withheld_sources.some((source) => typeof source !== 'string'))) ||
    (record.collector_held !== undefined && typeof record.collector_held !== 'boolean') ||
    (record.last_admission_held !== undefined && typeof record.last_admission_held !== 'boolean') ||
    (record.last_observation_at !== undefined &&
      (typeof record.last_observation_at !== 'string' ||
        !Number.isFinite(Date.parse(record.last_observation_at)) ||
        Date.parse(record.last_observation_at) > Date.parse(record.last_run_at))) ||
    (record.last_admission_error_count !== undefined &&
      (!Number.isSafeInteger(record.last_admission_error_count) ||
        Number(record.last_admission_error_count) < 0)) ||
    (record.last_success_at !== undefined &&
      (typeof record.last_success_at !== 'string' ||
        !Number.isFinite(Date.parse(record.last_success_at)) ||
        Date.parse(record.last_success_at) > Date.parse(record.last_run_at)))
  )
    throw new Error('Invalid continuous cadence state');
  return record as unknown as CadenceCheckpoint;
}

export function readCheckpoint(
  file: string,
  readState: CadenceReader | undefined
): CadenceCheckpoint | undefined {
  const stored = readState
    ? readState(file)
    : safeExistsSync(file)
      ? parseSafeJsonInput(
          safeReadFileSnapshot(file, 1_048_576).toString('utf8'),
          'continuous cadence'
        )
      : undefined;
  return stored === undefined ? undefined : parseCheckpoint(stored);
}

export function scheduledAfter(
  schedule: NonNullable<ContinuousOperationsConfig['schedule']>,
  checkpoint: CadenceCheckpoint
): number {
  return Date.parse(checkpoint.last_run_at) + schedule.every_seconds * 1000;
}

/** Read-only projection of the same durable cadence used by the resident sweep. */
export function inspectContinuousCadence(
  config: ContinuousOperationsConfig,
  charter: DotCharter | undefined,
  options: { rootDir?: string; readState?: CadenceReader; now?: Date } = {}
) {
  const { enabled, schedule, loop_id, dot_id, scope } = config;
  const identity = { loop_id, dot_id, scope };
  if (!enabled || !schedule) return { ...identity, status: 'disabled' as const };
  if (!charter) return { ...identity, status: 'charter_unavailable' as const };
  if (!matches(charter, config)) return { ...identity, status: 'inactive' as const };
  const root = options.rootDir ?? pathResolver.rootDir();
  const checkpoint = readCheckpoint(stateFile(root, charter, config), options.readState);
  if (!checkpoint) return { ...identity, status: 'awaiting_first_tick' as const };
  const earliest = scheduledAfter(schedule, checkpoint);
  return {
    ...identity,
    status:
      (options.now ?? new Date()).getTime() < earliest ? ('waiting' as const) : ('due' as const),
    last_run_at: checkpoint.last_run_at,
    last_success_at: checkpoint.last_success_at ?? null,
    last_observation_at: checkpoint.last_observation_at ?? null,
    last_admission_error_count: checkpoint.last_admission_error_count ?? null,
    last_admission_held: checkpoint.last_admission_held ?? false,
    collector_held: checkpoint.collector_held ?? false,
    last_withheld_sources: checkpoint.last_withheld_sources ?? [],
    ...(checkpoint.collector_held
      ? { next: 'Verify the interrupted collector run and its effects before replay.' }
      : {}),
    earliest_next_tick_at: new Date(earliest).toISOString(),
    latest_attempt_completed: checkpoint.last_run_at === checkpoint.last_success_at,
  };
}
