import { getDeploymentAdapter } from '@agent/core/actuator/deployment-adapter';
import { RISKY_OPS } from '@agent/core/risky-op-registry';
import { runAdfActuatorPipeline } from '@agent/core/actuator/actuator-sdk';
import {
  DEFAULT_MAX_PIPELINE_STEPS,
  DEFAULT_PIPELINE_TIMEOUT_MS,
} from '@agent/core/execution-bounds';
import { resolveVars } from '@agent/core/logic-utils';
import { ensureDefaultOpPreflight } from '@agent/core/pipeline/op-preflight-defaults';
import { runOpPreflight } from '@agent/core/pipeline/op-preflight';
import { nowIso } from '@agent/core/foundation';
import {
  runExternalOperation,
  assertExternalOperationBatchResumable,
} from '@agent/core/governance/external-operation';
import { withExternalOperationOccurrence } from '@agent/core/governance/external-operation-occurrence';
import { describeOps } from './op-catalog.js';

export interface DeploymentParams {
  mission_id: string;
  project_name: string;
  version: string;
  environment: string;
  release_notes_path?: string;
}

export interface DeploymentAction {
  action: 'deploy_release' | 'pipeline';
  params?: DeploymentParams;
  steps?: Array<{
    type: 'capture' | 'transform' | 'apply' | 'control';
    op: string;
    params: Record<string, unknown>;
  }>;
  context?: Record<string, unknown>;
  options?: { max_steps?: number; timeout_ms?: number };
}

async function deployRelease(params: DeploymentParams) {
  if (!params.mission_id || !params.project_name || !params.version || !params.environment) {
    throw new Error('[deploy_release] requires mission_id, project_name, version, and environment');
  }
  const adapter = getDeploymentAdapter();
  const result = await runExternalOperation(
    {
      operationId: 'deployment:deploy_release',
      effect: { adapter: adapter.name, params: { ...params } },
      requiresApproval: true,
      approvalPolicy: { intentId: RISKY_OPS.CONFIG_UPDATE, scope: 'governance' },
      // Release effects/costs are adapter-specific; no generic delegation grant.
      delegable: false,
    },
    () =>
      adapter.deploy({
        environment: params.environment,
        projectName: params.project_name,
        version: params.version,
        releaseNotesPath: params.release_notes_path,
      }),
    (result) => (result.status === 'triggered' ? 'succeeded' : 'unknown')
  );
  if (result.status !== 'triggered') {
    throw Object.assign(
      new Error(
        `[DEPLOYMENT_UNVERIFIED] ${result.status}; verify the release before any new invocation`
      ),
      {
        adfControlFlow: 'preflight' as const,
      }
    );
  }
  return result;
}

export async function handleDeploymentAction(input: DeploymentAction) {
  if (input.action === 'deploy_release') {
    ensureDefaultOpPreflight();
    const preflight = await runOpPreflight({
      op: 'deployment:deploy_release',
      params: (input.params || {}) as Record<string, unknown>,
      source: 'actuator',
    });
    if (preflight.decision !== 'allow') {
      throw new Error(
        `[OP_PREFLIGHT_${preflight.decision.toUpperCase()}] ${preflight.reason || 'Operation deployment:deploy_release was not admitted.'}`
      );
    }
    return deployRelease(preflight.input as unknown as DeploymentParams);
  }
  assertExternalOperationBatchResumable(
    (input.steps || []).filter((step) => step.op === 'deploy_release').length
  );
  let occurrence = 0;
  const result = await runAdfActuatorPipeline({
    actuatorId: 'deployment',
    steps: input.steps || [],
    context: { ...(input.context || {}), timestamp: nowIso() },
    options: {
      maxSteps: input.options?.max_steps || DEFAULT_MAX_PIPELINE_STEPS,
      timeoutMs: input.options?.timeout_ms || DEFAULT_PIPELINE_TIMEOUT_MS,
    },
    handlers: {
      capture: async () => {
        throw new Error('[UNKNOWN_OP] Deployment actuator does not own capture operations');
      },
      transform: async () => {
        throw new Error('[UNKNOWN_OP] Deployment actuator does not own transform operations');
      },
      control: async () => {
        throw new Error('[UNKNOWN_OP] Deployment actuator does not own control operations');
      },
      apply: async (op, rawParams, context) => {
        if (!describeOps().some((entry) => entry.op === op && entry.kind === 'apply')) {
          throw new Error(`[UNKNOWN_OP] Unknown deployment op: ${op}`);
        }
        const params = Object.fromEntries(
          Object.entries(rawParams || {}).map(([key, value]) => [key, resolveVars(value, context)])
        ) as unknown as DeploymentParams & { export_as?: string };
        const value = await withExternalOperationOccurrence(`deployment:${occurrence++}`, () =>
          deployRelease(params)
        );
        return { ...context, [params.export_as || 'deploy_result']: value };
      },
    },
  });
  return result;
}
