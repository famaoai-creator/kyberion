import { logger } from './core.js';
import { getReasoningBackend } from './reasoning-backend.js';
import { sendOpsAlert } from './ops-alert.js';

/**
 * AR-01 Task 4: single autonomous-repair implementation shared by every
 * runner (run_pipeline, super-nerve). Previously each carried its own copy
 * and only run_pipeline enforced the AO-03 §4 sensitive-path guardrail —
 * super-nerve would happily dispatch a repair subagent for .env/auth/config
 * failures. Centralizing here closes that gap for all callers.
 */

export interface RepairFailure {
  category: string;
  detail?: string;
  label?: string;
  repairAction?: string;
}

export interface RepairStepRef {
  op: string;
  id?: string;
  params?: unknown;
}

export interface RepairPolicy {
  effort?: unknown;
  budget?: unknown;
}

export interface AutonomousRepairRequest {
  step: RepairStepRef;
  failure: RepairFailure;
  /** When set, the repair targets this pipeline ADF file. */
  pipelinePath?: string;
  policy?: RepairPolicy;
  /**
   * Post-repair verification (e.g. re-validate the ADF). A throw means the
   * repair did not actually leave the target in a valid state → false.
   */
  validate?: () => Promise<unknown>;
  /** Log prefix, e.g. '[SYS_PIPELINE:REPAIR]' or '[NERVE:REPAIR]'. */
  logPrefix?: string;
}

// Repairs that would touch .env / authority / config / secrets MUST NOT run
// without operator approval (AO-03 §4, SA-02). Unattended runs have no
// approval channel, so we fail closed and escalate.
const SENSITIVE_CATEGORIES = ['permission_error', 'auth_error', 'config_error', 'env_error'];

export async function attemptAutonomousRepair(request: AutonomousRepairRequest): Promise<boolean> {
  const { step, failure, pipelinePath, policy, validate } = request;
  const prefix = request.logPrefix || '[REPAIR]';
  try {
    if (SENSITIVE_CATEGORIES.includes(failure.category)) {
      logger.warn(
        `  ${prefix} Repair category "${failure.category}" involves .env/auth/config changes ` +
          `— autonomous mutation of sensitive paths is prohibited (AO-03 §4). Escalating to operator.`
      );
      sendOpsAlert({
        severity: 'critical',
        title: `Pipeline repair blocked: ${step.op}`,
        context: {
          step_op: step.op,
          error_category: failure.category,
          error_detail: failure.detail ?? '',
          ...(pipelinePath ? { pipeline_path: pipelinePath } : {}),
        },
        recommendation:
          'Manual operator intervention required. Review the error, update .env / authority roles as appropriate, then re-run the pipeline.',
        dedupe_key: `pipeline-repair-blocked:${step.op}:${failure.category}`,
      });
      return false;
    }

    const backend = getReasoningBackend();
    const repairHint =
      failure.repairAction ||
      'Investigate the error and the pipeline ADF structure to identify a potential fix.';
    const fixTarget = pipelinePath
      ? `FIX the pipeline ADF structure at ${pipelinePath} if it is a structural or parameter error.`
      : 'FIX the failing step definition or the repository state it depends on, if the error is structural.';

    const instruction = `
The following pipeline step failed in Kyberion:
Step Operation: ${step.op}
Step Params: ${JSON.stringify(step.params ?? {})}
Error Category: ${failure.category}
Error Detail: ${failure.detail ?? ''}

Repair Hint: ${repairHint}
${policy ? `Step Policy: ${JSON.stringify(policy)}` : ''}

Repair Action Goal:
1. ANALYZE the error and parameters.
2. ${fixTarget}
3. DO NOT modify .env files, authority roles, config secrets, or any file outside the pipeline ADF.
   If the error requires such changes, output a description of what needs to be changed but do NOT apply it.
4. Ensure the resulting ADF follows the required schema.

Assume the persona of a "Sovereign System Recovery Agent".
Once finished, provide a brief summary of the changes you applied to fix the pipeline.
`.trim();

    const report = await backend.delegateTask(
      instruction,
      `Self-Healing Mission for ${step.op}`,
      policy ? ({ effort: policy.effort, budget: policy.budget } as any) : undefined
    );
    logger.info(`  ${prefix} Sub-agent report: ${report}`);

    if (validate) {
      try {
        await validate();
      } catch (validationErr: any) {
        logger.warn(
          `  ${prefix} Sub-agent finished but the repair target is still invalid: ${validationErr.message}`
        );
        return false;
      }
    }
    return true;
  } catch (err: any) {
    logger.error(`  ${prefix} Failed to perform repair: ${err.message}`);
    return false;
  }
}
