import {
  BaseComputeDriver,
  registerComputeDriver,
  type ComputeJobSpec,
  type ComputeJobState,
} from './compute-driver.js';

export class LocalComputeDriver extends BaseComputeDriver {
  readonly providerId = 'local';

  async submitJob(spec: ComputeJobSpec): Promise<ComputeJobState> {
    const state: ComputeJobState = {
      job_id: spec.job_id,
      provider: this.providerId,
      status: 'completed',
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      exit_code: 0,
      message: 'Local execution completed',
      artifacts: ['output.json'],
    };
    this.stateStore.set(spec.job_id, state);
    return state;
  }
}

// Auto-register local compute driver
registerComputeDriver(new LocalComputeDriver());
