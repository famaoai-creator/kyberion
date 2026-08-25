import { getRegisteredEnvText, setRegisteredEnv } from '@agent/core/foundation';
import {
  validateAndRepairAdf,
  recordGovernanceAction,
  TraceContext,
  finalizeAndPersist,
  persistTrace,
  classifyError,
  logger,
  safeExec,
  safeReadFile,
  safeExistsSync,
  safeWriteFile,
  safeMkdir,
  retry,
  resolveVars,
  evaluateCondition,
  capabilityEntry,
  findMissionPath,
  missionEvidenceDir,
  pathResolver,
  installReasoningBackends,
  getReasoningBackend,
  getReasoningRuntimeInstructions,
  renderRuntimeInstructions,
  buildWorkingPrinciplesLines,
  executeReportContract,
  getReasoningPayloadScope,
  delegateStructured,
  createApprovalRequest,
  loadApprovalRequest,
  isApprovalRequestExpired,
  selectJudgeRoute,
  resolveMaxRouteHops,
  detectRouteCycle,
  resolveFacets,
  renderFacets,
  resolveStepReasoningRoute,
  runFeedbackLoop,
  determineActuatorStepType,
  resolveActuatorOperation,
  resolveActuatorOperationTimeout,
  getSemanticDecideDegradations,
  appendSemanticDegradationRun,
  recordAdhocPipelineRun,
  PROMOTION_CANDIDATE_MIN_RUNS,
  safeExecResult,
  runJanitor,
  checkActuatorCapabilities,
  compactStepOutputContext,
  killSwitch,
  validateOpInput,
  getRegisteredEnv,
  resolveIdentityContext,
  executeAdfSteps,
  runAdfLifecycle,
  skipAdfStep,
  type AdfStep,
  type AdfStepHandlers,
  type AdfStepHooks,
  type AdfRunResult,
  type AdfSkippedStep,
  type ReasoningCallOptions,
  type ReasoningPromptVisibilityContext,
  executeProgrammaticToolCall,
  getDefaultWorkerEventStream,
  getDefaultLifecycleHookEngine,
  fireLifecycleHooks,
  withActuatorForwardingPort,
  type ActuatorForwardRequest,
  type ActuatorForwardingPort,
  withReasoningPayloadScope,
  runToolCallBatch,
  resolveOpAccessClaims,
  type ResourceClaim,
  type OpInputDomain,
  createPipelineRunJournal,
  openPipelineRunJournal,
  loadPipelineRunJournal,
  newPipelineRunId,
  hashPipelineOutput,
  type PipelineRunJournalHandle,
  type PipelineRunJournalState,
  type PipelineRunSuspendedPayload,
  deriveExecutionGraph,
  createGraphRunArtifact,
  recordGraphRunNode,
  persistGraphRunArtifact,
  type GraphRunArtifact,
  assessPipelineDryRun,
} from '@agent/core';

import { runOpPreflight } from '@agent/core/op-preflight';
import { ensureDefaultOpPreflight } from '@agent/core/op-preflight-defaults';
import { z } from 'zod';
import { tryRepairJson } from '@agent/core/json-repair';
import { installPythonVoiceBridgeIfAvailable } from '@agent/core/python-voice-bridge';
import {
  markRouterActive,
  markRouterInactive,
  resetRouterSync,
} from '@agent/core/blackhole-routing-guard';
import * as nodePath from 'node:path';
import {
  derivePipelineStatus,
  type PipelineAdfStep,
  type PipelineStepReasoning,
  ROLE_FROM_TYPE,
} from '@agent/core/pipeline-contract';
import {
  formatPipelineFailure,
  logNextActionForPipelineFailure,
  type PipelineFailure,
} from './pipeline-result-reporting.js';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDirectScript } from './lib/harness.js';
import { readValidatedWorkflowAdf } from './refactor/adf-input.js';
import { runStepHooks } from './refactor/step-hooks.js';

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
