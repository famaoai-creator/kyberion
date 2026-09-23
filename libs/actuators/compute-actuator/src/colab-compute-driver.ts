import {
  BaseComputeDriver,
  registerComputeDriver,
  type ComputeJobSpec,
  type ComputeJobState,
} from './compute-driver.js';

import { safeWriteFile, safeMkdir } from '@agent/core/secure-io';
import * as path from 'node:path';

export class ColabComputeDriver extends BaseComputeDriver {
  readonly providerId = 'colab';

  async submitJob(spec: ComputeJobSpec): Promise<ComputeJobState> {
    const startedAt = new Date().toISOString();

    // Stage the compute job contract and metadata payload to the Drive bridge scratch path
    const driveRoot =
      process.env.GOOGLE_DRIVE_ROOT || path.join('active', 'shared', 'tmp', 'colab_bridge');
    const jobDir = path.join(driveRoot, 'jobs', spec.job_id);
    safeMkdir(jobDir, { recursive: true });

    const contractPayload = {
      job_id: spec.job_id,
      provider: 'colab',
      notebook_path: spec.notebook_path,
      hardware: spec.hardware ?? { accelerator: 'gpu', gpu_type: 'any' },
      params: spec.params ?? {},
      submitted_at: startedAt,
      status: 'queued',
    };

    const contractFile = path.join(jobDir, 'job-contract.json');
    safeWriteFile(contractFile, JSON.stringify(contractPayload, null, 2));

    // Expected artifacts defined by job specification or standard Colab output
    const artifacts = [path.join(jobDir, 'output.safetensors'), path.join(jobDir, 'metrics.json')];

    const isDriveConfigured = Boolean(
      process.env.GOOGLE_DRIVE_ROOT || process.env.GOOGLE_APPLICATION_CREDENTIALS
    );

    const state: ComputeJobState = {
      job_id: spec.job_id,
      provider: this.providerId,
      status: isDriveConfigured ? 'running' : 'pending',
      started_at: startedAt,
      message: isDriveConfigured
        ? `Colab background runtime execution queued on Google Drive bridge (Google AI Pro priority compute, hardware: ${spec.hardware?.gpu_type || 'standard'})`
        : `Colab job contract staged to '${jobDir}'. Awaiting Google Drive sync or authenticated Colab runner connection.`,
      artifacts,
    };

    this.stateStore.set(spec.job_id, state);
    return state;
  }
}

// Auto-register Colab compute driver
registerComputeDriver(new ColabComputeDriver());
