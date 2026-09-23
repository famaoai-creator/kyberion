import {
  BaseComputeDriver,
  registerComputeDriver,
  type ComputeJobSpec,
  type ComputeJobState,
} from './compute-driver.js';

import { safeExecResult, safeWriteFile, safeMkdir } from '@agent/core/secure-io';
import * as path from 'node:path';

export class LocalComputeDriver extends BaseComputeDriver {
  readonly providerId = 'local';

  async submitJob(spec: ComputeJobSpec): Promise<ComputeJobState> {
    const startedAt = new Date().toISOString();
    const artifacts: string[] = [];

    // If an entrypoint or script is provided, execute it via governed safeExecResult
    if (spec.entrypoint) {
      const parts = spec.entrypoint.trim().split(/\s+/);
      const cmd = parts[0];
      const args = parts.slice(1);

      // Pass job params as serialized JSON environment variable
      const env: Record<string, string> = {
        KYBERION_COMPUTE_JOB_ID: spec.job_id,
      };
      if (spec.params) {
        env.KYBERION_COMPUTE_PARAMS = JSON.stringify(spec.params);
      }

      const execRes = safeExecResult(cmd, args, {
        env,
        timeoutMs: 60000,
      });

      const finishedAt = new Date().toISOString();
      const isSuccess = execRes.status === 0;

      // Save output telemetry log as artifact
      const logDir = path.join('active', 'shared', 'tmp', 'compute', spec.job_id);
      safeMkdir(logDir, { recursive: true });
      const logPath = path.join(logDir, 'execution.log');
      safeWriteFile(
        logPath,
        `=== STDOUT ===\n${execRes.stdout}\n=== STDERR ===\n${execRes.stderr}\n=== STATUS ===\n${execRes.status}\n`
      );
      artifacts.push(logPath);

      const state: ComputeJobState = {
        job_id: spec.job_id,
        provider: this.providerId,
        status: isSuccess ? 'completed' : 'failed',
        started_at: startedAt,
        finished_at: finishedAt,
        exit_code: execRes.status ?? (isSuccess ? 0 : 1),
        message: isSuccess
          ? `Local execution of '${cmd}' completed successfully`
          : `Local execution of '${cmd}' failed with status ${execRes.status}: ${execRes.stderr}`,
        artifacts,
      };

      this.stateStore.set(spec.job_id, state);
      return state;
    }

    // Default fast-path execution (e.g. data preparation or job registration)
    const outDir = path.join('active', 'shared', 'tmp', 'compute', spec.job_id);
    safeMkdir(outDir, { recursive: true });
    const outJsonPath = path.join(outDir, 'output.json');
    safeWriteFile(
      outJsonPath,
      JSON.stringify(
        {
          job_id: spec.job_id,
          provider: 'local',
          status: 'completed',
          params: spec.params ?? {},
        },
        null,
        2
      )
    );
    artifacts.push(outJsonPath);

    const state: ComputeJobState = {
      job_id: spec.job_id,
      provider: this.providerId,
      status: 'completed',
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      exit_code: 0,
      message: 'Local execution completed',
      artifacts,
    };
    this.stateStore.set(spec.job_id, state);
    return state;
  }
}

// Auto-register local compute driver
registerComputeDriver(new LocalComputeDriver());
