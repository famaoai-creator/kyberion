import {
  BaseComputeDriver,
  registerComputeDriver,
  type ComputeJobSpec,
  type ComputeJobState,
} from './compute-driver.js';

export class ColabComputeDriver extends BaseComputeDriver {
  readonly providerId = 'colab';

  async submitJob(spec: ComputeJobSpec): Promise<ComputeJobState> {
    const state: ComputeJobState = {
      job_id: spec.job_id,
      provider: this.providerId,
      status: 'running',
      started_at: new Date().toISOString(),
      message: 'Colab background runtime execution queued (Google AI Pro priority compute)',
      artifacts: ['model.safetensors', 'metrics.json'],
    };
    this.stateStore.set(spec.job_id, state);
    return state;
  }
}

// Auto-register Colab compute driver
registerComputeDriver(new ColabComputeDriver());
