/**
 * Typed-flow validated step execution: the ADF lifecycle (draft → preflight →
 * auto-repair → commit → execute) every pipeline entry runs its steps through.
 */
import { logger } from '@agent/core/core';
import { runAdfLifecycle } from '@agent/core/pipeline/adf-lifecycle';
import type { PipelineAdfStep } from '@agent/core/pipeline/pipeline-contract';
import { readValidatedWorkflowAdf } from '../refactor/adf-input.js';
import { runSteps } from './pipeline-execution-part-execution.js';
import {
  formatFlowValidationErrors,
  validateFlow,
  type RunStepsOptions,
} from './pipeline-execution-part-bootstrap.js';
import {
  assertDiagnosticPipelineProfile,
  DIAGNOSTIC_OPERATOR_GUIDANCE,
} from './pipeline-diagnostic-profile.js';

/** Validate Typed Flow channel integrity before allowing any step side effects. */
export class TypedFlowValidationError extends Error {
  constructor(readonly flowErrors: ReturnType<typeof validateFlow>) {
    super(formatFlowValidationErrors(flowErrors));
    this.name = 'TypedFlowValidationError';
  }
}

export async function runValidatedSteps(
  steps: PipelineAdfStep[],
  initialCtx: Record<string, unknown> = {},
  opts: RunStepsOptions = {}
) {
  assertDiagnosticPipelineProfile(opts.executionMode, opts.pipelinePath, steps);
  try {
    return (
      await runAdfLifecycle({
        draft: () => steps,
        preflight: (draft) => {
          const flowErrors = validateFlow(draft, initialCtx);
          if (flowErrors.length > 0) throw new TypedFlowValidationError(flowErrors);
          return draft;
        },
        // SX-11 / AGENTS.md: invalid pipeline contracts use the canonical
        // repair agent as the lifecycle's one auto-repair hook. The one-shot
        // guard prevents an unchanged repair from becoming a retry loop.
        autoRepair:
          opts.executionMode === undefined && opts.pipelinePath && !opts._adfRepairAttempted
            ? async (draft, failure) => {
                opts._adfRepairAttempted = true;
                const { attemptAutonomousRepair } = await import('@agent/core/autonomous-repair');
                const repaired = await attemptAutonomousRepair({
                  failure: {
                    category:
                      failure instanceof TypedFlowValidationError ? 'typed_flow' : 'preflight',
                    detail: failure instanceof Error ? failure.message : String(failure),
                    repairAction: 'repair the typed pipeline flow and re-run preflight',
                  },
                  step: { op: 'core:validate_flow' },
                  pipelinePath: opts.pipelinePath,
                  trustResolved: opts.trustResolved,
                  projectTrustApprovalId: opts.projectTrustApprovalId,
                });
                if (!repaired) {
                  throw new TypedFlowValidationError(validateFlow(draft, initialCtx));
                }
                return (
                  await readValidatedWorkflowAdf(opts.pipelinePath!, {
                    trustResolved: opts.trustResolved,
                    projectTrustApprovalId: opts.projectTrustApprovalId,
                  })
                ).steps;
              }
            : undefined,
        commit: (prepared) => prepared,
        execute: (committed) => runSteps(committed, initialCtx, opts),
      })
    ).result;
  } catch (error) {
    if (!(error instanceof TypedFlowValidationError)) throw error;

    const message = error.message + (opts.executionMode ? '; ' + DIAGNOSTIC_OPERATOR_GUIDANCE : '');
    for (const flowError of error.flowErrors) {
      logger.warn(`[FLOW_VALIDATION] ${formatFlowValidationErrors([flowError])}.`);
    }
    opts.trace?.addEvent('pipeline.validation_failed', {
      validation_type: 'typed_flow',
      error: message,
      error_count: error.flowErrors.length,
    });
    return {
      status: 'failed' as const,
      results: [{ op: 'flow:validate', status: 'failed' as const, error: message }],
      context: { ...initialCtx },
    };
  }
}
