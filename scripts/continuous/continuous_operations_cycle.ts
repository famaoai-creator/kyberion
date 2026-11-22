/** One scoped observation/admission cycle, shared by CLI, pipeline and resident cadence. */
import { findDotCharter, type DotCharter } from '@agent/core/dot/dot-charter';
import {
  assertContinuousOperationsCollectionAuthority,
  collectContinuousOperationsSources,
  type ContinuousCollectionDeps,
} from '@agent/core/organization/continuous-operations-sources';
import {
  runContinuousOperations,
  type ContinuousOperationsDeps,
  type ContinuousOperationsReport,
} from '@agent/core/organization/continuous-operations';
import { observeContinuousWork } from './continuous_operations_outcomes.js';
import { runAsDotCharter } from '@agent/core/dot/dot-key-results';
import { loadContinuousOperationsConfig } from './continuous_operations_config.js';
import type { ContinuousOperationsConfig } from '@agent/core/organization/continuous-operations-policy';
import { pipelineFileRunner } from '../lib/pipeline-file-runner.js';
import { organizationCadenceLifecycle } from '@agent/core/organization/organization-cadence';
import { readCheckpoint, stateFile } from './continuous_operations_cadence.js';
import { pathResolver } from '@agent/core/path-resolver';
import {
  CollectorUnavailable,
  readCollectorAttempt,
  readCollectorSnapshot,
  withCollectorAttempt,
} from './continuous_collector_state.js';
import {
  assertCollectorWorkerAvailable,
  runContinuousCollectorProcess,
} from './continuous_collector_process.js';
import { getOperationsHaltState } from '@agent/core/governance/operations-halt';

export interface ContinuousCycleOptions {
  apply?: boolean;
  recoverAdmissions?: boolean;
  now?: Date;
  rootDir?: string;
  assertExecutionCurrent?: () => void;
  holdAdmission?: boolean;
  holdCollector?: boolean;
  collector?: (ref: string, charter: DotCharter, assertCurrent: () => void) => Promise<void>;
}
export interface ContinuousCycleDeps {
  charter?: (id: string, rootDir?: string) => DotCharter | undefined;
  collection?: ContinuousCollectionDeps;
  runtime?: ContinuousOperationsDeps;
  clock?: () => Date;
  organizationActive?: () => boolean;
  outcomes?: (charter: DotCharter, report: ContinuousOperationsReport) => unknown[];
}
export async function runContinuousOperationsCycle(
  config: ContinuousOperationsConfig,
  options: ContinuousCycleOptions = {},
  deps: ContinuousCycleDeps = {}
) {
  const charter = deps.charter
    ? deps.charter(config.dot_id, options.rootDir)
    : findDotCharter(config.dot_id, options.rootDir)?.charter;
  if (!charter) throw new Error('Continuous loop dot charter not found: ' + config.dot_id);
  const observationOwnerNhi = charter.scope.owner_nhi;
  const root = options.rootDir ?? pathResolver.rootDir();
  const governed = !deps.collection?.authorize;
  const withheldSources = new Set<string>();
  const start = options.now ?? deps.clock?.() ?? new Date();
  const holdCollector =
    options.holdCollector ||
    (options.apply &&
      !deps.collection?.authorize &&
      (() => {
        assertContinuousOperationsCollectionAuthority(config, charter);
        const root = options.rootDir ?? pathResolver.rootDir();
        return readCheckpoint(stateFile(root, charter, config), undefined)?.collector_held;
      })());
  const organizationActive =
    deps.organizationActive ??
    (() =>
      organizationCadenceLifecycle(
        {
          organizationId: config.scope.organization_id,
          tenantSlug: config.scope.tenant_slug,
          tier: config.scope.tier,
        },
        options.rootDir
      ) === 'active');
  const collectorDeadline = Date.now() + (charter.goal?.budget?.wall_clock_ms_per_wake ?? 60_000);
  const collectWithEffects = options.apply === true && organizationActive() && !holdCollector;
  const assertEffectCurrent = () => {
    options.assertExecutionCurrent?.();
    if (governed && getOperationsHaltState().halted) throw new Error('Continuous effects halted');
    if (!organizationActive()) throw new Error('Continuous effect requires an active organization');
  };
  options.assertExecutionCurrent?.();
  let now = start;
  const collectorUnavailable = (error: unknown): never => {
    throw new CollectorUnavailable(
      error instanceof CollectorUnavailable ? error.message : 'Collector execution is unavailable'
    );
  };
  const snapshots = await collectContinuousOperationsSources(
    config,
    { charter, apply: collectWithEffects, now: start, rootDir: options.rootDir, withheldSources },
    {
      ...deps.collection,
      ...(governed
        ? {
            pipelineHeld: (ref: string) => {
              if (holdCollector || !charter.authority.allowed_pipelines?.includes(ref)) return true;
              try {
                return readCollectorAttempt(root, charter, ref)?.status === 'unconfirmed';
              } catch {
                return true;
              }
            },
            readPipeline: (ref, current, capture) =>
              readCollectorSnapshot(root, current, ref, capture).catch(collectorUnavailable),
            isPipelineUnavailable: (error: unknown) => error instanceof CollectorUnavailable,
          }
        : {}),
      executePipeline: (ref, charter, capture) => {
        if (governed) {
          const assertCollectorCurrent = () => {
            assertEffectCurrent();
            const current = findDotCharter(charter.dot_id, root)?.charter;
            if (
              !current ||
              current.scope.owner_nhi !== observationOwnerNhi ||
              !current.authority.allowed_pipelines?.includes(ref)
            )
              throw new Error('Collector authorization was withdrawn');
            assertContinuousOperationsCollectionAuthority(config, current);
          };
          return withCollectorAttempt(
            root,
            charter,
            ref,
            assertCollectorCurrent,
            async (attemptId, register) => {
              assertCollectorWorkerAvailable(root);
              await runContinuousCollectorProcess(
                ref,
                charter,
                collectorDeadline,
                root,
                undefined,
                assertCollectorCurrent,
                attemptId,
                register
              );
            },
            capture
          ).catch(collectorUnavailable);
        }
        assertEffectCurrent();
        return (
          options.collector?.(ref, charter, assertEffectCurrent) ??
          deps.collection?.executePipeline?.(ref, charter, capture) ??
          executeCollectorPipeline(ref, charter, assertEffectCurrent)
        );
      },
      clock: () => {
        now = new Date(Math.max(start.getTime(), (deps.clock?.() ?? new Date()).getTime()));
        return now;
      },
    }
  );
  options.assertExecutionCurrent?.();
  const report = runContinuousOperations(
    config,
    {
      ...options,
      apply: options.apply === true && organizationActive() && !options.holdAdmission,
      assertExecutionCurrent: assertEffectCurrent,
      withheldSources,
      now,
      ...(config.enabled ? { snapshots, observationOwnerNhi } : {}),
    },
    deps.runtime
  );
  const outcomes = deps.outcomes
    ? deps.outcomes(charter, report)
    : observeContinuousWork(charter, report, options.rootDir);
  return {
    ...report,
    withheld_sources: [...withheldSources],
    admission_held: options.apply === true && !report.applied,
    inventory: report.inventory.map((entry) => ({
      ...entry,
      ...(entry.dot_status ? { admission_dot_status: entry.dot_status } : {}),
    })),
    outcomes,
  };
}
export async function runContinuousOperationsCycleFromRef(
  ref: string,
  options: ContinuousCycleOptions = {}
) {
  const config = loadContinuousOperationsConfig(ref);
  return runContinuousOperationsCycle(config, options);
}
async function executeCollectorPipeline(
  pipelineRef: string,
  charter: DotCharter,
  assertExecutionCurrent?: () => void
): Promise<void> {
  // The collector has checked the charter allowlist and exact scope before this port.
  const result = await runAsDotCharter(charter, () =>
    pipelineFileRunner()(pipelineRef, {
      ...(assertExecutionCurrent ? { assertExecutionCurrent } : {}),
      context: {
        tier: charter.scope.tier,
        tenant_slug: charter.scope.tenant_slug,
        organization_id: charter.scope.organization_id,
        ...(charter.scope.project_id ? { project_id: charter.scope.project_id } : {}),
      },
      payloadScope: {
        tier: charter.scope.tier,
        ...(charter.scope.tenant_slug ? { tenant_slug: charter.scope.tenant_slug } : {}),
      },
      quiet: true,
      hasHuman: false,
    })
  );
  if (
    !result ||
    typeof result !== 'object' ||
    !('status' in result) ||
    result.status !== 'succeeded' ||
    !('results' in result) ||
    !Array.isArray(result.results) ||
    result.results.some((entry) => !entry || typeof entry !== 'object' || entry.status === 'failed')
  )
    throw new Error('Continuous collector pipeline failed: ' + pipelineRef);
}
