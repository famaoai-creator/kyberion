/** One scoped observation/admission cycle, shared by CLI, pipeline and resident cadence. */
import { findDotCharter, type DotCharter } from '@agent/core/dot/dot-charter';
import {
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
import { pipelineFileRunner } from './lib/pipeline-file-runner.js';

export interface ContinuousCycleOptions {
  apply?: boolean;
  recoverAdmissions?: boolean;
  now?: Date;
  rootDir?: string;
}
export interface ContinuousCycleDeps {
  charter?: (id: string, rootDir?: string) => DotCharter | undefined;
  collection?: ContinuousCollectionDeps;
  runtime?: ContinuousOperationsDeps;
  clock?: () => Date;
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
  const start = options.now ?? deps.clock?.() ?? new Date();
  const snapshots = await collectContinuousOperationsSources(
    config,
    { charter, apply: options.apply, now: start, rootDir: options.rootDir },
    {
      executePipeline: executeCollectorPipeline,
      ...deps.collection,
      ...(deps.clock ? { clock: deps.clock } : {}),
    }
  );
  const now =
    options.apply && config.sources.some((source) => source.kind === 'pipeline')
      ? new Date(Math.max(start.getTime(), (deps.clock?.() ?? new Date()).getTime()))
      : start;
  const report = runContinuousOperations(
    config,
    { ...options, now, ...(config.enabled ? { snapshots } : {}) },
    deps.runtime
  );
  const outcomes = deps.outcomes
    ? deps.outcomes(charter, report)
    : observeContinuousWork(charter, report, options.rootDir);
  return { ...report, outcomes };
}
export async function runContinuousOperationsCycleFromRef(
  ref: string,
  options: ContinuousCycleOptions = {}
) {
  const config = loadContinuousOperationsConfig(ref);
  return runContinuousOperationsCycle(config, options);
}
async function executeCollectorPipeline(pipelineRef: string, charter: DotCharter): Promise<void> {
  // The collector has checked the charter allowlist and exact scope before this port.
  const result = await runAsDotCharter(charter, () =>
    pipelineFileRunner()(pipelineRef, {
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
