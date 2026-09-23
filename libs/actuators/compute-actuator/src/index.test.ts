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

  it('submits, executes, and collects artifacts for a local compute job with entrypoint', async () => {
    const { safeExistsSync, safeReadFile } = await import('@agent/core/secure-io');
    const path = await import('node:path');

    // Submit a job with a real echo command entrypoint
    const submitResult = (await handleAction('submit_job', {
      job_id: 'test-job-local-exec-01',
      provider: 'local',
      entrypoint: 'node -e console.log("KyberionComputeDone")',
      params: { batch_size: 32 },
    })) as ComputeJobState;

    expect(submitResult.status).toBe('completed');
    expect(submitResult.provider).toBe('local');
    expect(submitResult.exit_code).toBe(0);
    expect(submitResult.artifacts?.length).toBeGreaterThan(0);

    const pollResult = (await handleAction('poll_status', {
      job_id: 'test-job-local-exec-01',
    })) as ComputeJobState;
    expect(pollResult.status).toBe('completed');

    // Collect the execution log into destination
    const targetDir = 'active/shared/tmp/compute_collected_test/';
    const collectResult = (await handleAction('collect_artifact', {
      job_id: 'test-job-local-exec-01',
      target_path: targetDir,
    })) as { collected: string[]; destination: string };

    expect(collectResult.destination).toBe(targetDir);
    expect(collectResult.collected).toContain('execution.log');

    // Verify artifact file actually exists at destination path
    const collectedFilePath = path.join(targetDir, 'execution.log');
    expect(safeExistsSync(collectedFilePath)).toBe(true);
    const logContent = safeReadFile(collectedFilePath, { encoding: 'utf8' }) as string;
    expect(logContent).toContain('KyberionComputeDone');
  });

  it('submits and manages a colab compute job contract', async () => {
    const { safeExistsSync } = await import('@agent/core/secure-io');

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

    expect(['pending', 'running']).toContain(submitResult.status);
    expect(submitResult.provider).toBe('colab');

    // Verify contract JSON payload was staged
    expect(
      safeExistsSync('active/shared/tmp/colab_bridge/jobs/test-job-colab-01/job-contract.json')
    ).toBe(true);

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
