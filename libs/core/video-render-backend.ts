import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { buildSafeExecEnv, safeExec, safeExistsSync } from './secure-io.js';
import type { VideoCompositionRenderPlan, VideoRenderRuntimePolicy } from './video-composition-contract.js';

export interface VideoRenderBackendResult {
  executed: boolean;
  backend: 'none' | 'hyperframes_cli';
  output_path?: string;
  command?: string[];
  reason?: string;
}

export interface VideoRenderBackendExecutionOptions {
  isCancelled?: () => boolean;
  poll_interval_ms?: number;
}

export function renderVideoCompositionBundle(
  plan: VideoCompositionRenderPlan,
  policy: VideoRenderRuntimePolicy,
): VideoRenderBackendResult {
  if (!policy.render.enable_backend_rendering) {
    return {
      executed: false,
      backend: policy.render.backend,
      reason: 'backend rendering disabled by policy',
    };
  }

  if (policy.render.backend === 'none') {
    return {
      executed: false,
      backend: 'none',
      reason: 'backend set to none',
    };
  }

  if (policy.render.backend !== 'hyperframes_cli') {
    throw new Error(`Unsupported video render backend: ${policy.render.backend}`);
  }

  const outputPath = resolveOutputPath(plan);
  const command = [
    'hyperframes',
    'render',
    plan.bundle_dir,
    '--output',
    outputPath,
    '--format',
    plan.output_format,
    '--fps',
    String(plan.fps),
    '--quality',
    policy.render.quality,
  ];

  safeExec('npx', command, {
    timeoutMs: policy.render.command_timeout_ms,
    cwd: process.cwd(),
  });

  if (!safeExistsSync(outputPath)) {
    throw new Error(`Render backend completed without output artifact: ${outputPath}`);
  }

  return {
    executed: true,
    backend: 'hyperframes_cli',
    output_path: outputPath,
    command: ['npx', ...command],
  };
}

export async function renderVideoCompositionBundleAsync(
  plan: VideoCompositionRenderPlan,
  policy: VideoRenderRuntimePolicy,
  options: VideoRenderBackendExecutionOptions = {},
): Promise<VideoRenderBackendResult> {
  if (!policy.render.enable_backend_rendering) {
    return {
      executed: false,
      backend: policy.render.backend,
      reason: 'backend rendering disabled by policy',
    };
  }

  if (policy.render.backend === 'none') {
    return {
      executed: false,
      backend: 'none',
      reason: 'backend set to none',
    };
  }

  if (policy.render.backend !== 'hyperframes_cli') {
    throw new Error(`Unsupported video render backend: ${policy.render.backend}`);
  }

  const outputPath = resolveOutputPath(plan);
  const command = [
    'hyperframes',
    'render',
    plan.bundle_dir,
    '--output',
    outputPath,
    '--format',
    plan.output_format,
    '--fps',
    String(plan.fps),
    '--quality',
    policy.render.quality,
  ];

  await runCancellableCommand('npx', command, {
    timeout_ms: policy.render.command_timeout_ms,
    is_cancelled: options.isCancelled,
    poll_interval_ms: options.poll_interval_ms || 100,
  });

  if (!safeExistsSync(outputPath)) {
    throw new Error(`Render backend completed without output artifact: ${outputPath}`);
  }

  return {
    executed: true,
    backend: 'hyperframes_cli',
    output_path: outputPath,
    command: ['npx', ...command],
  };
}

function resolveOutputPath(plan: VideoCompositionRenderPlan): string {
  if (plan.output_target_path && plan.output_target_path.trim()) {
    return path.resolve(process.cwd(), plan.output_target_path.trim());
  }
  const ext = plan.output_format;
  return path.join(plan.bundle_dir, `output.${ext}`);
}

async function runCancellableCommand(
  command: string,
  args: string[],
  options: {
    timeout_ms: number;
    is_cancelled?: () => boolean;
    poll_interval_ms: number;
  },
): Promise<void> {
  if (options.is_cancelled?.()) {
    throw new Error('video render cancelled');
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: buildSafeExecEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    let settled = false;
    let timeoutHandle: NodeJS.Timeout | null = null;
    let pollHandle: NodeJS.Timeout | null = null;
    let cancelled = false;

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (pollHandle) clearInterval(pollHandle);
      if (err) reject(err);
      else resolve();
    };

    child.stderr?.on('data', (chunk) => {
      if (stderr.length > 4096) return;
      stderr += String(chunk);
    });

    child.on('error', (error) => {
      finish(error as Error);
    });

    child.on('close', (code, signal) => {
      if (cancelled) {
        finish(new Error('video render cancelled'));
        return;
      }
      if (code === 0) {
        finish();
        return;
      }
      const tail = stderr.trim();
      const detail = tail ? `: ${tail.split('\n').slice(-1)[0]}` : '';
      finish(new Error(`video render backend command failed (code=${String(code)}, signal=${String(signal)})${detail}`));
    });

    timeoutHandle = setTimeout(() => {
      cancelled = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1000);
    }, options.timeout_ms);

    if (options.is_cancelled) {
      pollHandle = setInterval(() => {
        if (!options.is_cancelled?.()) return;
        cancelled = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 1000);
      }, options.poll_interval_ms);
    }
  });
}
