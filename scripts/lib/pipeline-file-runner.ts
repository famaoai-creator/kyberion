/**
 * Pipeline file runner port — lets code that the pipeline engine itself
 * reaches (e.g. `core:organization_operation_tick` → scheduled organization
 * operations) run a nested pipeline file without importing the engine.
 *
 * Importing `run_pipeline` / `pipeline-execution-part-results` from there
 * would close a runtime import cycle (engine → domain ops → operation
 * executor → engine). The engine registers its `executePipelineFile` when it
 * loads; CLI entry points that run operations outside a pipeline load the
 * engine first (see `scripts/organization.ts`).
 */

import type { executePipelineFile } from '../pipeline-execution-part-results.js';

export type PipelineFileRunner = typeof executePipelineFile;

let registered: PipelineFileRunner | null = null;

export function registerPipelineFileRunner(runner: PipelineFileRunner): void {
  registered = runner;
}

export function pipelineFileRunner(): PipelineFileRunner {
  if (!registered) {
    throw new Error(
      'pipeline file runner is not registered — load the pipeline engine (run_pipeline) before running a nested pipeline'
    );
  }
  return registered;
}
