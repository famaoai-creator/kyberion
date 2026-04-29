import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { buildSafeExecEnv, safeExec, safeExistsSync, safeMoveSync, safeRmSync, platform } from './index.js';
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

export class VideoRenderBackendCommandError extends Error {
  public readonly cancelled: boolean;
  public readonly timed_out: boolean;
  public readonly signal: string | null;
  public readonly exit_code: number | null;

  constructor(message: string, options: {
    cancelled?: boolean;
    timed_out?: boolean;
    signal?: string | null;
    exit_code?: number | null;
  } = {}) {
    super(message);
    this.name = 'VideoRenderBackendCommandError';
    this.cancelled = Boolean(options.cancelled);
    this.timed_out = Boolean(options.timed_out);
    this.signal = options.signal ?? null;
    this.exit_code = options.exit_code ?? null;
  }
}

export async function renderVideoCompositionBundle(
  plan: VideoCompositionRenderPlan,
  policy: VideoRenderRuntimePolicy,
): Promise<VideoRenderBackendResult> {
  if (!policy.render.enable_backend_rendering) {
    return {
      executed: false,
      backend: policy.render.backend as any,
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

  // Check for render capability via platform abstraction
  const caps = await platform.getCapabilities();
  
  if (policy.render.backend === 'hyperframes_cli') {
    if (!caps.hasFFmpeg) {
      return {
        executed: false,
        backend: 'hyperframes_cli',
        reason: 'ffmpeg not found on this platform. Please install ffmpeg to enable video rendering.',
      };
    }

    const outputPath = resolveOutputPath(plan);
    const execEnv = buildSafeExecEnv({
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ? `${process.env.NODE_OPTIONS} ` : ''}--require=${path.resolve(process.cwd(), 'scripts/hyperframes-localhost-preload.cjs')}`,
    });
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
      env: execEnv,
    });

    if (!safeExistsSync(outputPath)) {
      throw new Error(`Render backend completed without output artifact: ${outputPath}`);
    }

    if (plan.narration_ref) {
      if (!safeExistsSync(plan.narration_ref)) {
        throw new Error(`Narration artifact missing for mux: ${plan.narration_ref}`);
      }
      await muxNarrationTrack(outputPath, plan.narration_ref, plan.output_format);
    }

    return {
      executed: true,
      backend: 'hyperframes_cli',
      output_path: outputPath,
      command: ['npx', ...command],
    };
  }

  throw new Error(`Unsupported video render backend: ${policy.render.backend}`);
}

export async function renderVideoCompositionBundleAsync(
  plan: VideoCompositionRenderPlan,
  policy: VideoRenderRuntimePolicy,
  options: VideoRenderBackendExecutionOptions = {},
): Promise<VideoRenderBackendResult> {
  if (!policy.render.enable_backend_rendering) {
    return {
      executed: false,
      backend: policy.render.backend as any,
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

  // Check for render capability via platform abstraction
  const caps = await platform.getCapabilities();

  if (policy.render.backend === 'hyperframes_cli') {
    if (!caps.hasFFmpeg) {
      return {
        executed: false,
        backend: 'hyperframes_cli',
        reason: 'ffmpeg not found on this platform. Please install ffmpeg to enable video rendering.',
      };
    }

    const outputPath = resolveOutputPath(plan);
    const execEnv = buildSafeExecEnv({
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ? `${process.env.NODE_OPTIONS} ` : ''}--require=${path.resolve(process.cwd(), 'scripts/hyperframes-localhost-preload.cjs')}`,
    });
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
      env: execEnv,
    });

    if (!safeExistsSync(outputPath)) {
      throw new Error(`Render backend completed without output artifact: ${outputPath}`);
    }

    if (plan.narration_ref) {
      if (!safeExistsSync(plan.narration_ref)) {
        throw new Error(`Narration artifact missing for mux: ${plan.narration_ref}`);
      }
      await muxNarrationTrackAsync(outputPath, plan.narration_ref, plan.output_format);
    }

    return {
      executed: true,
      backend: 'hyperframes_cli',
      output_path: outputPath,
      command: ['npx', ...command],
    };
  }

  throw new Error(`Unsupported video render backend: ${policy.render.backend}`);
}

function resolveOutputPath(plan: VideoCompositionRenderPlan): string {
  if (plan.output_target_path && plan.output_target_path.trim()) {
    return path.resolve(process.cwd(), plan.output_target_path.trim());
  }
  const ext = plan.output_format;
  return path.join(plan.bundle_dir, `output.${ext}`);
}

async function muxNarrationTrack(
  outputPath: string,
  narrationPath: string,
  outputFormat: VideoCompositionRenderPlan['output_format'],
): Promise<void> {
  const tempOutputPath = buildMuxTempPath(outputPath);
  const args = buildMuxArgs(outputPath, narrationPath, tempOutputPath, outputFormat);
  await platform.runMediaCommand('ffmpeg', args);
  finalizeMuxedOutput(tempOutputPath, outputPath);
}

async function muxNarrationTrackAsync(
  outputPath: string,
  narrationPath: string,
  outputFormat: VideoCompositionRenderPlan['output_format'],
): Promise<void> {
  const tempOutputPath = buildMuxTempPath(outputPath);
  const args = buildMuxArgs(outputPath, narrationPath, tempOutputPath, outputFormat);
  await platform.runMediaCommand('ffmpeg', args);
  finalizeMuxedOutput(tempOutputPath, outputPath);
}

function buildMuxArgs(
  inputVideoPath: string,
  narrationPath: string,
  outputPath: string,
  outputFormat: VideoCompositionRenderPlan['output_format'],
): string[] {
  const args = [
    '-y',
    '-i',
    inputVideoPath,
    '-i',
    narrationPath,
    '-map',
    '0:v:0',
    '-map',
    '1:a:0',
    '-c:v',
    'copy',
    '-c:a',
    outputFormat === 'webm' ? 'libopus' : 'aac',
    '-shortest',
  ];
  if (outputFormat === 'mp4' || outputFormat === 'mov') {
    args.push('-movflags', '+faststart');
  }
  args.push(outputPath);
  return args;
}

function finalizeMuxedOutput(tempOutputPath: string, outputPath: string): void {
  if (!safeExistsSync(tempOutputPath)) {
    throw new Error(`Mux completed without output artifact: ${tempOutputPath}`);
  }
  if (safeExistsSync(outputPath)) {
    safeRmSync(outputPath);
  }
  safeMoveSync(tempOutputPath, outputPath);
}

function buildMuxTempPath(outputPath: string): string {
  const ext = path.extname(outputPath) || '.mp4';
  const base = outputPath.slice(0, outputPath.length - ext.length);
  return `${base}.muxed${ext}`;
}

async function runCancellableCommand(
  command: string,
  args: string[],
  options: {
    timeout_ms: number;
    is_cancelled?: () => boolean;
    poll_interval_ms: number;
    env?: NodeJS.ProcessEnv;
  },
): Promise<void> {
  if (options.is_cancelled?.()) {
    throw new VideoRenderBackendCommandError('video render cancelled', {
      cancelled: true,
      timed_out: false,
      signal: null,
      exit_code: null,
    });
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: options.env || buildSafeExecEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    let settled = false;
    let timeoutHandle: NodeJS.Timeout | null = null;
    let pollHandle: NodeJS.Timeout | null = null;
    let cancelled = false;
    let timedOut = false;

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
        finish(new VideoRenderBackendCommandError('video render cancelled', {
          cancelled: true,
          timed_out: timedOut,
          signal: signal || null,
          exit_code: code,
        }));
        return;
      }
      if (code === 0) {
        finish();
        return;
      }
      const tail = stderr.trim();
      const detail = tail ? `: ${tail.split('\n').slice(-1)[0]}` : '';
      finish(new VideoRenderBackendCommandError(
        `video render backend command failed (code=${String(code)}, signal=${String(signal)})${detail}`,
        {
          cancelled: false,
          timed_out: false,
          signal: signal || null,
          exit_code: code,
        },
      ));
    });

    timeoutHandle = setTimeout(() => {
      cancelled = true;
      timedOut = true;
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
