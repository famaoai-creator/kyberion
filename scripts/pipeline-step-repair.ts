import { assertPipelineExecutionCurrent } from './pipeline-execution-part-bootstrap.js';
import { refineErrorClassification } from '@agent/core/error-classifier-judgment';
import { logger } from '@agent/core/core';
import type { AdfSkippedStep } from '@agent/core/pipeline/adf-engine';
import type { PipelineAdfStep } from '@agent/core/pipeline/pipeline-contract';
import type { RunStepsOptions, ReasoningStepPolicy } from './pipeline-execution-part-bootstrap.js';
import { DIAGNOSTIC_OPERATOR_GUIDANCE } from './pipeline-diagnostic-profile.js';
import { readValidatedWorkflowAdf } from './refactor/adf-input.js';
import { findStepByIdRecursive } from './pipeline-execution-part-control.js';

/**
 * AR-01 Phase B: retry + autonomous-repair extracted into a higher-order
 * function that wraps a single step-execution attempt, instead of being
 * loop machinery inlined in runSteps. The canonical engine
 * (executeAdfSteps) has no built-in retry, so Phase C delegation needs
 * retry/repair as something a handler opts into, not something the engine
 * itself does — this is the shape that opt-in takes.
 */
export async function runWithRepair(
  step: PipelineAdfStep,
  opts: RunStepsOptions,
  stepPolicy: ReasoningStepPolicy,
  attemptOnce: () => Promise<Record<string, unknown> | AdfSkippedStep>
): Promise<Record<string, unknown> | AdfSkippedStep> {
  if (opts.executionMode) {
    // runSteps validated the original ADF before the engine added its internal
    // type/resolved-parameter fields. Never classify or repair this attempt.
    if (opts.executionMode !== 'front_desk_diagnostic')
      throw new Error('Invalid bounded diagnostic execution mode');
    try {
      return await attemptOnce();
    } catch (error) {
      throw new Error(
        String(error instanceof Error ? error.message : error) + '; ' + DIAGNOSTIC_OPERATOR_GUIDANCE
      );
    }
  }
  let attempt = 0;
  let lastError: any = null;
  while (attempt < 2) {
    try {
      return await attemptOnce();
    } catch (err: any) {
      if (err?.adfControlFlow === 'preflight' || err?.adfControlFlow === 'suspend') throw err;
      assertPipelineExecutionCurrent(opts);
      lastError = err;
      // classifyError(), refined only by a calibrated judgment (inert until a fit lands).
      const failure = await refineErrorClassification(err);

      // Don't repair if we already tried and the error message didn't change (prevents loops)
      if (attempt === 0 && failure.repairAction) {
        if (!opts.quiet) {
          logger.warn(
            `  [SYS_PIPELINE] Step failed: ${failure.label}. Attempting autonomous repair...`
          );
          logger.info(
            // i18n-exempt: JA operator log (product language)
            `  [SYS_PIPELINE] 修復サブエージェント実行中(数分かかることがあります) — ${step.op}`
          );
        }
        const { attemptAutonomousRepair } = await import('@agent/core/autonomous-repair');
        const repaired = await attemptAutonomousRepair({
          step: { op: step.op, id: step.id, params: step.params },
          failure,
          pipelinePath: opts.pipelinePath,
          trustResolved: opts.trustResolved,
          projectTrustApprovalId: opts.projectTrustApprovalId,
          policy: {
            ...(stepPolicy.effort ? { effort: stepPolicy.effort } : {}),
            ...(stepPolicy.budget ? { budget: stepPolicy.budget } : {}),
          },
          logPrefix: '[SYS_PIPELINE:REPAIR]',
        });
        if (repaired) {
          if (!opts.quiet) {
            logger.success(
              `  [SYS_PIPELINE] Repair successful. Refreshing ADF and retrying step ${step.op}...`
            );
          }
          try {
            // Reload fully from disk to get the REPAIRED definition. Search
            // recursively — the failing step may be nested inside
            // core:if/foreach/while/on_error.fallback — and match by id only.
            const refreshedPipeline = await readValidatedWorkflowAdf(opts.pipelinePath!, {
              trustResolved: opts.trustResolved,
              projectTrustApprovalId: opts.projectTrustApprovalId,
            });
            const refreshedStep = step.id
              ? findStepByIdRecursive(refreshedPipeline.steps, step.id)
              : undefined;

            if (refreshedStep) {
              // Update the step object in place so the next attempt picks it up
              step.op = refreshedStep.op;
              step.params = refreshedStep.params;
              logger.info(
                `  [SYS_PIPELINE] Step definition refreshed for ${step.id || step.op}. New path: ${(step.params as any).path}`
              );
            } else if (!opts.quiet) {
              logger.warn(
                `  [SYS_PIPELINE] Could not uniquely re-locate step "${step.id || step.op}" in the repaired ADF (missing/unmatched id) — retrying with the original step definition unchanged.`
              );
            }

            attempt++;
            continue; // Re-evaluate normalizedOp/domain/action/params with the (possibly unchanged) values
          } catch (reloadErr: any) {
            logger.warn(
              `  [SYS_PIPELINE] Failed to reload ADF after repair: ${reloadErr.message}.`
            );
          }
        }
      }
      throw lastError;
    }
  }
  throw lastError;
}
