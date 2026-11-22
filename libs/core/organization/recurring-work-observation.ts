import * as path from 'node:path';
import { pathResolver } from '../path-resolver.js';
import { safeRealpath } from '../secure-io.js';
import {
  isScheduleTimingDue,
  listScheduledPipelines,
  type ScheduledPipeline,
} from '../pipeline/pipeline-scheduler.js';
import type { StorageDataTier } from '../storage-layout.js';
import { isReservedScopeName, isValidTenantSlug } from '../entity-scope.js';

type DependencyScope = { tier: StorageDataTier; tenant_slug?: string };

export function isScopedScheduleRef(scope: DependencyScope, ref: string): boolean {
  if (
    !ref.endsWith('.json') ||
    ref.includes('\\') ||
    ref.split('/').some((part) => !part || part === '.' || part === '..')
  )
    return false;
  if (scope.tier === 'public' && !scope.tenant_slug) return ref.startsWith('pipelines/');
  if (
    scope.tier !== 'confidential' ||
    !scope.tenant_slug ||
    !isValidTenantSlug(scope.tenant_slug) ||
    isReservedScopeName(scope.tenant_slug)
  )
    return false;
  const prefix = `knowledge/confidential/${scope.tenant_slug}/pipelines/`;
  return ref.startsWith(prefix) && !ref.slice(prefix.length).includes('/');
}

/** Observe the registered dependency's health under the scheduler's canonical path custody. */
export function observePipelineScheduleDependencies(
  scope: DependencyScope,
  pipelineRefs: readonly string[],
  options: {
    rootDir?: string;
    now?: Date;
    list?: typeof listScheduledPipelines;
    realpath?: typeof safeRealpath;
  } = {}
) {
  const refs = new Set(pipelineRefs.filter((ref) => isScopedScheduleRef(scope, ref)));
  if (!refs.size) return [];
  const root = path.resolve(options.rootDir ?? pathResolver.rootDir());
  const now = options.now ?? new Date();
  const canonicalRoot = (options.realpath ?? safeRealpath)(root);

  function matches(schedule: ScheduledPipeline): boolean {
    const ref = schedule.pipelinePath;
    if (!refs.has(ref)) return false;
    const absolute = path.join(root, ref);
    const actual = (options.realpath ?? safeRealpath)(absolute);
    if (actual !== path.join(canonicalRoot, ref))
      throw new Error('Scheduled dependency path cannot traverse symlinks.');
    return true;
  }

  return (options.list ?? listScheduledPipelines)({ rootDir: root })
    .filter(matches)
    .map((schedule) => {
      const failing =
        schedule.lastStatus === 'failed' ||
        (schedule.consecutiveFailures ?? 0) > 0 ||
        (!schedule.enabled && Boolean(schedule.disabledReason));
      const registration = schedule.enabled
        ? 'enabled'
        : schedule.optIn
          ? 'requires_opt_in'
          : 'disabled';
      const timingDue =
        registration === 'requires_opt_in'
          ? null
          : schedule.enabled && isScheduleTimingDue(schedule, undefined, now);
      return {
        schedule_id: schedule.id,
        pipeline_ref: schedule.pipelinePath,
        relationship: 'scheduled_dependency' as const,
        registration,
        execution_eligibility:
          registration === 'disabled' ? 'disabled_in_registry' : 'chronos_policy_unobserved',
        last_result: schedule.lastStatus ?? null,
        timing_due: timingDue,
        potentially_due: timingDue === null && isScheduleTimingDue(schedule, undefined, now),
        status: failing
          ? 'failing'
          : !schedule.enabled
            ? 'disabled'
            : timingDue
              ? 'due'
              : schedule.lastStatus === 'succeeded'
                ? 'succeeded'
                : 'awaiting_first_run',
        last_run_at: schedule.lastRun ?? null,
      };
    })
    .sort((a, b) => a.schedule_id.localeCompare(b.schedule_id));
}
