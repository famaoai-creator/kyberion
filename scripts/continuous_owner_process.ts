/** Cancellable, supervised child controller for the continuous owner. */
import { randomUUID } from 'node:crypto';
import { spawnManagedProcess, stopManagedProcess } from '@agent/core/managed-process';
import { buildSafeExecEnv } from '@agent/core/secure-io';
export interface ContinuousOwnerProcessOptions {
  cwd: string;
  env: Record<string, string | undefined>;
  timeoutMs: number;
  maxOutputMB: number;
  signal?: AbortSignal;
}
export interface ContinuousOwnerProcessResult {
  stdout: string;
  stderr: string;
  status: number | null;
  error?: Error;
}
export function runContinuousOwnerProcess(
  command: string,
  args: string[],
  options: ContinuousOwnerProcessOptions
): Promise<ContinuousOwnerProcessResult> {
  if (options.signal?.aborted)
    return Promise.reject(new Error('Continuous owner controller aborted before spawn'));
  if (process.platform === 'win32')
    return Promise.reject(
      new Error(
        'Continuous owner requires supervised process-tree cancellation; Windows execution is unavailable'
      )
    );
  return new Promise((resolve) => {
    const resourceId = 'continuous-owner:' + randomUUID();
    const { child } = spawnManagedProcess({
      resourceId,
      kind: 'service',
      ownerId: 'continuous-work-owner',
      ownerType: 'mission_controller',
      command,
      args,
      shutdownPolicy: 'manual',
      metadata: {
        tenant_slug: options.env.KYBERION_TENANT,
        organization_id: options.env.KYBERION_ORGANIZATION_ID,
      },
      spawnOptions: {
        cwd: options.cwd,
        env: buildSafeExecEnv(options.env),
        shell: false,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    });
    let stdout = '',
      stderr = '',
      bytes = 0,
      settled = false;
    let failure: Error | undefined;
    const killGroup = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch (error) {
          if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH'))
            failure = error instanceof Error ? error : new Error(String(error));
        }
      }
    };
    const stop = (error: Error) => {
      failure = error;
      killGroup();
    };
    const onAbort = () => stop(new Error('Continuous owner controller aborted'));
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    const timer = setTimeout(
      () => stop(new Error('Continuous owner controller deadline exceeded')),
      options.timeoutMs
    );
    const finish = (status: number | null, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // A successful controller may leave workers with detached stdio behind.
      // Keep group ownership until those descendants have been terminated too.
      killGroup();
      options.signal?.removeEventListener('abort', onAbort);
      stopManagedProcess(resourceId, null);
      resolve({ stdout, stderr, status, ...(error || failure ? { error: error ?? failure } : {}) });
    };
    const append = (channel: 'stdout' | 'stderr', chunk: Buffer | string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > options.maxOutputMB * 1024 * 1024) {
        stop(new Error('Continuous owner controller output limit exceeded'));
        return;
      }
      if (channel === 'stdout') stdout += String(chunk);
      else stderr += String(chunk);
    };
    child.stdout?.on('data', (chunk: Buffer) => append('stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer) => append('stderr', chunk));
    // AbortError means a kill was requested. Wait for close before reporting settlement.
    child.on('error', (error: Error) => {
      failure = error;
      if (!child.pid) finish(null, error);
    });
    child.on('close', (status: number | null) => finish(status));
  });
}
