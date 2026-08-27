import { logger } from '@agent/core';

import { isDirectScript } from './lib/harness.js';

import { recordFallbackOutcome } from './pipeline-execution-part-bootstrap.js';
import { finalizePipelineTrace } from './pipeline-execution-part-bootstrap.js';
import { normalizeStepBudget } from './pipeline-execution-part-bootstrap.js';
import { normalizeReasoningPolicy } from './pipeline-execution-part-bootstrap.js';
import { summarizeReasoningPolicy } from './pipeline-execution-part-bootstrap.js';
import { buildReasoningPolicyNote } from './pipeline-execution-part-bootstrap.js';
import { isReasoningBudgetExceeded } from './pipeline-execution-part-bootstrap.js';
import { validateFlow } from './pipeline-execution-part-bootstrap.js';
import { normalizePipelineOp } from './pipeline-execution-part-bootstrap.js';
import { findStepByIdRecursive } from './pipeline-execution-part-control.js';
import { runSteps } from './pipeline-execution-part-execution.js';
import { runValidatedSteps } from './pipeline-execution-part-results.js';
import { executePipelineFile } from './pipeline-execution-part-results.js';
import { main } from './pipeline-execution-part-results.js';
export type { NormalizedStepBudget } from './pipeline-execution-part-bootstrap.js';
export type { ReasoningStepPolicy } from './pipeline-execution-part-bootstrap.js';
export type { FlowValidationError } from './pipeline-execution-part-bootstrap.js';
export type { ExecutePipelineFileOptions } from './pipeline-execution-part-results.js';
export { formatPipelineFailure } from './pipeline-result-reporting.js';

export {
  recordFallbackOutcome,
  finalizePipelineTrace,
  normalizeStepBudget,
  normalizeReasoningPolicy,
  summarizeReasoningPolicy,
  buildReasoningPolicyNote,
  isReasoningBudgetExceeded,
  validateFlow,
  normalizePipelineOp,
  findStepByIdRecursive,
  runSteps,
  runValidatedSteps,
  executePipelineFile,
  main,
};
import { main as runPipelineMain } from './pipeline-execution-part-results.js';

const isDirectRun =
  isDirectScript(import.meta.url, 'run_pipeline.ts') ||
  isDirectScript(import.meta.url, 'run_pipeline.js');
if (isDirectRun) {
  runPipelineMain().catch((err) => {
    logger.error(err.message);
    process.exitCode = 1;
  });
}
