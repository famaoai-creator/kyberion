import { describe, expect, it } from 'vitest';
import { handleAction } from './compute-actuator-helpers.js';
import { describeOps } from './op-catalog.js';
import type { ComputeDriver, ComputeJobSpec, ComputeJobState } from './compute-driver.js';
import './local-compute-driver.js';
import './colab-compute-driver.js';

describe('compute-actuator', () => {
  it('describes canonical compute ops in catalog', () => {
    const ops = describeOps();
    const names = ops.map((o) => o.op);
    expect(names).toContain('submit_job');
    expect(names).toContain('poll_status');
    expect(names).toContain('collect_artifact');
    expect(names).toContain('cancel_job');
  });

  it('submits and polls a local compute job', async () => {
    const submitResult = (await handleAction('submit_job', {
      job_id: 'test-job-local-01',
      provider: 'local',
    })) as ComputeJobState;
    expect(submitResult.status).toBe('completed');
    expect(submitResult.provider).toBe('local');

    const pollResult = (await handleAction('poll_status', {
      job_id: 'test-job-local-01',
    })) as ComputeJobState;
    expect(pollResult.status).toBe('completed');

    const collectResult = (await handleAction('collect_artifact', {
      job_id: 'test-job-local-01',
      target_path: 'active/shared/artifacts/',
    })) as { collected: string[]; destination: string };
    expect(collectResult.destination).toBe('active/shared/artifacts/');
  });

  it('submits and manages a colab compute job', async () => {
    const submitResult = (await handleAction('submit_job', {
      job_id: 'test-job-colab-01',
      provider: 'colab',
      notebook_path: 'notebooks/train.ipynb',
      hardware: {
        accelerator: 'gpu',
        gpu_type: 'a100',
        high_ram: true,
      },
    })) as ComputeJobState;
    expect(submitResult.status).toBe('running');
    expect(submitResult.provider).toBe('colab');
    expect(submitResult.message).toContain('Google AI Pro');

    const cancelResult = (await handleAction('cancel_job', {
      job_id: 'test-job-colab-01',
    })) as ComputeJobState;
    expect(cancelResult.status).toBe('cancelled');
  });

  it('supports registering new compute seam providers (extensibility)', async () => {
    const { registerComputeDriver, listComputeProviders } = await import('./compute-driver.js');
    const mockCustomDriver: ComputeDriver = {
      providerId: 'modal',
      submitJob: async (spec: ComputeJobSpec): Promise<ComputeJobState> => ({
        job_id: spec.job_id,
        provider: 'modal',
        status: 'completed',
        message: 'Executed on Modal cloud container',
      }),
      pollStatus: async (jobId: string): Promise<ComputeJobState> => ({
        job_id: jobId,
        provider: 'modal',
        status: 'completed',
      }),
      collectArtifact: async (_jobId: string, dest: string) => ({
        collected: ['modal_output.tar.gz'],
        destination: dest,
      }),
      cancelJob: async (jobId: string): Promise<ComputeJobState> => ({
        job_id: jobId,
        provider: 'modal',
        status: 'cancelled',
      }),
    };

    registerComputeDriver(mockCustomDriver);
    expect(listComputeProviders()).toContain('modal');

    const result = (await handleAction('submit_job', {
      job_id: 'test-custom-01',
      provider: 'modal',
    })) as ComputeJobState;
    expect(result.provider).toBe('modal');
    expect(result.message).toContain('Modal cloud container');
  });
});
