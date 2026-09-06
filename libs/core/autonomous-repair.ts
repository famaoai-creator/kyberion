import { logger } from './core.js';
import { sendOpsAlert } from './ops-alert.js';
import { validateAndRepairAdf } from './adf-repair-agent.js';
import type { ReasoningCallOptions } from './reasoning-backend.js';

/**
 * AR-01 compatibility boundary for callers that still use the old repair
 * helper. File-backed ADF repair is implemented only by
 * `validateAndRepairAdf`; this function preserves the boolean API while
 * refusing in-memory repairs that have no durable, schema-validated target.
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
  /** Explicit project-trust decision for a project-local pipeline ADF. */
  trustResolved?: boolean;
  /** Durable approval for the exact project-local pipeline ADF. */
  projectTrustApprovalId?: string;
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
  const { step, failure, pipelinePath, trustResolved, projectTrustApprovalId, policy, validate } =
    request;
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

    // A repair is only safe when the canonical ADF file and its schema are
    // available. In-memory super-nerve runs have no durable contract to edit;
    // they must return the original failure instead of granting a repair
    // sub-agent arbitrary repository mutation authority.
    if (!pipelinePath) {
      logger.warn(
        `  ${prefix} Repair skipped: a durable pipeline ADF path is required for canonical validation.`
      );
      return false;
    }

    const result = await validateAndRepairAdf(pipelinePath, 'pipeline-adf', {
      step,
      failure,
      trustResolved,
      projectTrustApprovalId,
      delegationOptions: policy
        ? ({ effort: policy.effort, budget: policy.budget } as ReasoningCallOptions)
        : undefined,
    });
    if (!result.repaired) {
      logger.warn(
        `  ${prefix} Canonical ADF repair did not produce a valid pipeline: ${result.errors?.join('; ') || 'unknown repair failure'}`
      );
      return false;
    }

    if (validate) {
      try {
        await validate();
      } catch (validationErr: any) {
        logger.warn(
          `  ${prefix} Canonical ADF repair completed but caller validation failed: ${validationErr.message}`
        );
        return false;
      }
    }
    logger.info(`  ${prefix} Canonical ADF repair succeeded for ${pipelinePath}.`);
    return true;
  } catch (err: any) {
    logger.error(`  ${prefix} Failed to perform canonical ADF repair: ${err.message}`);
    return false;
  }
}
