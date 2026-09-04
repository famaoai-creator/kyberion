import { defineScript, isDirectScript } from './lib/harness.js';

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

/** Stable names for frequently used repository pipelines. */
export const PIPELINE_PRESETS: Readonly<Record<string, string>> = Object.freeze({
  'vital-check': 'pipelines/vital-check.json',
  'system-diagnostics': 'pipelines/system-diagnostics.json',
  'voice-health-check': 'pipelines/voice-health-check.json',
  'speak-with-my-voice': 'knowledge/product/pipeline-templates/speak-with-my-voice.json',
  'create-my-avatar': 'knowledge/product/pipeline-templates/create-my-avatar.json',
  'clone-my-voice': 'knowledge/product/pipeline-templates/clone-my-voice.json',
});

/** Expand a governed preset without changing the existing --input contract. */
export function resolvePipelinePresetArgs(args: readonly string[]): string[] {
  const first = args[0];
  const input = first ? PIPELINE_PRESETS[first] : undefined;
  if (!input || first.startsWith('-')) return [...args];
  return ['--input', input, ...args.slice(1)];
}

import { main as runPipelineMain } from './pipeline-execution-part-results.js';

const isDirectRun =
  isDirectScript(import.meta.url, 'run_pipeline.ts') ||
  isDirectScript(import.meta.url, 'run_pipeline.js');
if (isDirectRun) {
  void defineScript({
    name: 'pipeline',
    flags: [],
    run: ({ argv, print }) => runPipelineMain(resolvePipelinePresetArgs(argv), print),
  })();
}
