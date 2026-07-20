import {
  getDeploymentAdapter,
  requireApprovalForOp,
  RISKY_OPS,
  executeAdfSteps,
  resolveVars,
} from '@agent/core';
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
  const approval = requireApprovalForOp({
    opId: RISKY_OPS.CONFIG_UPDATE,
    agentId: 'mission_controller',
    correlationId: `${params.mission_id}:deploy:${params.environment}`,
    channel: 'system',
    payload: {
      scope: 'governance',
      environment: params.environment,
      version: params.version,
      projectName: params.project_name,
    },
    draft: {
      title: `Deploy ${params.project_name}@${params.version} → ${params.environment}`,
      summary: `Mission ${params.mission_id} requests release deployment.`,
      severity: params.environment === 'prod' ? 'high' : 'medium',
    },
  });
  if (!approval.allowed) {
    return {
      status: 'blocked_by_approval',
      approval_status: approval.status,
      approval_request_id: approval.requestId,
      message: approval.message,
    };
  }
  return getDeploymentAdapter().deploy({
    environment: params.environment,
    projectName: params.project_name,
    version: params.version,
    releaseNotesPath: params.release_notes_path,
  });
}

export async function handleDeploymentAction(input: DeploymentAction) {
  if (input.action === 'deploy_release') return deployRelease(input.params as DeploymentParams);
  const result = await executeAdfSteps(
    input.steps || [],
    { ...(input.context || {}), timestamp: new Date().toISOString() },
    { maxSteps: input.options?.max_steps || 1000, timeoutMs: input.options?.timeout_ms || 60000 },
    {
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
        const value = await deployRelease(params);
        return { ...context, [params.export_as || 'deploy_result']: value };
      },
    }
  );
  return result;
}
