import {
  resolveDriverForJob,
  type ComputeDriver,
  type ComputeJobHardwareSpec,
  type ComputeProviderType,
} from './compute-driver.js';

export interface ComputeActionInput {
  action: 'submit_job' | 'poll_status' | 'collect_artifact' | 'cancel_job';
  params: {
    job_id: string;
    provider?: ComputeProviderType;
    notebook_path?: string;
    entrypoint?: string;
    hardware?: ComputeJobHardwareSpec;
    params?: Record<string, unknown>;
    target_path?: string;
    artifact_names?: string[];
  };
}

type ComputeActionHandler = (
  driver: ComputeDriver,
  jobId: string,
  params: Record<string, unknown>
) => Promise<unknown>;

const ACTION_HANDLERS: Record<string, ComputeActionHandler> = {
  submit_job: (driver, jobId, params) =>
    driver.submitJob({
      job_id: jobId,
      provider: typeof params.provider === 'string' ? params.provider : undefined,
      notebook_path: typeof params.notebook_path === 'string' ? params.notebook_path : undefined,
      entrypoint: typeof params.entrypoint === 'string' ? params.entrypoint : undefined,
      hardware: params.hardware as ComputeJobHardwareSpec | undefined,
      params: params.params as Record<string, unknown> | undefined,
    }),

  poll_status: (driver, jobId) => driver.pollStatus(jobId),

  collect_artifact: (driver, jobId, params) => {
    if (!params.target_path) {
      throw new Error('compute-actuator — target_path is required for collect_artifact');
    }
    return driver.collectArtifact(
      jobId,
      String(params.target_path),
      Array.isArray(params.artifact_names) ? (params.artifact_names as string[]) : undefined
    );
  },

  cancel_job: (driver, jobId) => driver.cancelJob(jobId),
};

export async function handleAction(
  inputOrAction: unknown,
  maybeParams?: Record<string, unknown>
): Promise<unknown> {
  let action: string;
  let params: Record<string, unknown>;

  if (typeof inputOrAction === 'string') {
    action = inputOrAction;
    params = maybeParams || {};
  } else if (inputOrAction && typeof inputOrAction === 'object') {
    const record = inputOrAction as Record<string, unknown>;
    action = String(record.action || record.op || '');
    params = (record.params as Record<string, unknown>) || record;
  } else {
    throw new Error('compute-actuator — invalid action input');
  }

  const handler = ACTION_HANDLERS[action];
  if (!handler) {
    throw new Error(`compute-actuator — unknown action: ${action}`);
  }

  const jobId = String(params.job_id ?? '').trim();
  if (!jobId) {
    throw new Error(`compute-actuator — job_id is required for action: ${action}`);
  }

  const explicitProvider = params.provider ? String(params.provider) : undefined;
  const driver = resolveDriverForJob(jobId, explicitProvider);

  return handler(driver, jobId, params);
}
