import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  buildSafeExecEnv,
  safeExec,
  safeExistsSync,
  safeMkdir,
  safeMoveSync,
  safeRmSync,
  safeStat,
  safeWriteFile,
  platform,
  pathResolver,
} from './index.js';
import { resolveVideoBackend, type MediaBackendRecord } from './media-backend-registry.js';
import type { VideoCompositionRenderPlan, VideoRenderRuntimePolicy } from './video-composition-contract.js';

export interface VideoRenderBackendResult {
  executed: boolean;
  backend: 'none' | 'hyperframes_cli' | 'ffmpeg_fallback';
  output_path?: string;
  command?: string[];
  reason?: string;
  backend_id?: string;
  backend_kind?: MediaBackendRecord['kind'];
  backend_provider?: string;
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
  return renderVideoCompositionBundleImpl(plan, policy, { cancellable: false });
}

export async function renderVideoCompositionBundleAsync(
  plan: VideoCompositionRenderPlan,
  policy: VideoRenderRuntimePolicy,
  options: VideoRenderBackendExecutionOptions = {},
): Promise<VideoRenderBackendResult> {
  return renderVideoCompositionBundleImpl(plan, policy, {
    cancellable: true,
    isCancelled: options.isCancelled,
    pollIntervalMs: options.poll_interval_ms || 100,
  });
}

async function renderVideoCompositionBundleImpl(
  plan: VideoCompositionRenderPlan,
  policy: VideoRenderRuntimePolicy,
  options: {
    cancellable: boolean;
    isCancelled?: () => boolean;
    pollIntervalMs?: number;
  },
): Promise<VideoRenderBackendResult> {
  const rootDir = pathResolver.rootDir();
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
      backend_id: 'none',
    };
  }

  // Check for render capability via platform abstraction
  const caps = await platform.getCapabilities();

  if (policy.render.backend === 'hyperframes_cli') {
    const backend = resolveVideoBackend(policy.render.backend);
    if (!caps.hasFFmpeg) {
      return {
        executed: false,
        backend: 'hyperframes_cli',
        reason: 'ffmpeg not found on this platform. Please install ffmpeg to enable video rendering.',
        backend_id: backend.backend_id,
        backend_kind: backend.kind,
        backend_provider: backend.provider,
      };
    }

    const outputPath = resolveOutputPath(plan);
    const execEnv = buildSafeExecEnv({
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ? `${process.env.NODE_OPTIONS} ` : ''}--require=${pathResolver.rootResolve('scripts/hyperframes-localhost-preload.cjs')}`,
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

    try {
      if (options.cancellable) {
        await runCancellableCommand('npx', command, {
          timeout_ms: policy.render.command_timeout_ms,
          is_cancelled: options.isCancelled,
          poll_interval_ms: options.pollIntervalMs || 100,
          env: execEnv,
          cwd: rootDir,
        });
      } else {
        safeExec('npx', command, {
          timeoutMs: policy.render.command_timeout_ms,
          cwd: rootDir,
          env: execEnv,
        });
      }

      if (!safeExistsSync(outputPath)) {
        throw new Error(`Render backend completed without output artifact: ${outputPath}`);
      }
      if (!hasMinimumArtifactSize(outputPath, 1024)) {
        throw new Error(`Render backend produced a suspiciously small output artifact: ${outputPath}`);
      }
      if (!hasRequiredStreams(outputPath, true, false)) {
        throw new Error(`Render backend produced an invalid video container without a video stream: ${outputPath}`);
      }

      const audioRef = resolveMuxAudioRef(plan);
      if (audioRef) {
        if (options.cancellable) {
          await muxAudioTrackAsync(outputPath, audioRef, plan.output_format, plan.duration_sec);
        } else {
          await muxAudioTrack(outputPath, audioRef, plan.output_format, plan.duration_sec);
        }
        if (!hasMinimumArtifactSize(outputPath, 1024)) {
          throw new Error(`Mux produced a suspiciously small output artifact: ${outputPath}`);
        }
        if (!hasRequiredStreams(outputPath, true, true)) {
          throw new Error(`Mux completed without required audio/video streams: ${outputPath}`);
        }
      }

      return {
        executed: true,
        backend: 'hyperframes_cli',
        output_path: outputPath,
        command: ['npx', ...command],
        backend_id: backend.backend_id,
        backend_kind: backend.kind,
        backend_provider: backend.provider,
      };
    } catch (error: any) {
      const fallbackResult = await renderVideoCompositionFallback(plan, outputPath, error);
      return fallbackResult;
    }
  }

  throw new Error(`Unsupported video render backend: ${policy.render.backend}`);
}

async function renderVideoCompositionFallback(
  plan: VideoCompositionRenderPlan,
  outputPath: string,
  cause?: Error,
): Promise<VideoRenderBackendResult> {
  return renderNarratedFallbackVideo(plan, outputPath, cause);
}

export async function renderNarratedFallbackVideo(
  plan: VideoCompositionRenderPlan,
  outputPath: string,
  cause?: Error,
): Promise<VideoRenderBackendResult> {
  const rootDir = pathResolver.rootDir();
  const outputDir = path.dirname(outputPath);
  const baseName = path.basename(outputPath, path.extname(outputPath) || '.mp4');
  const workDir = path.join(outputDir, `${baseName}.fallback-work`);
  const sceneArtDir = path.join(workDir, 'scene-art');
  const sceneVideoDir = path.join(workDir, 'scene-video');
  const concatListPath = path.join(workDir, 'concat.txt');
  const silentPath = path.join(workDir, `${baseName}.silent.mp4`);
  safeMkdir(workDir, { recursive: true });
  safeMkdir(sceneArtDir, { recursive: true });
  safeMkdir(sceneVideoDir, { recursive: true });

  const segments = buildFallbackSegments(plan);
  const sceneVideoPaths: string[] = [];
  segments.forEach((segment, index) => {
    const sceneNumber = String(index + 1).padStart(2, '0');
    const sceneImagePath = path.join(sceneArtDir, `scene-${sceneNumber}.png`);
    const sceneVideoPath = path.join(sceneVideoDir, `scene-${sceneNumber}.mp4`);
    const sceneTitle = segment.title || `Scene ${sceneNumber}`;
    const sceneSubtitle = segment.subtitle || `${Math.max(1, Math.round(segment.duration_sec))}s`;
    safeExec('python3', [
      pathResolver.rootResolve('scripts/make_video_cover.py'),
      '--out',
      sceneImagePath,
      '--title',
      sceneTitle,
      '--subtitle',
      sceneSubtitle,
    ], {
      cwd: rootDir,
      timeoutMs: 30_000,
    });

    safeExec('ffmpeg', [
      '-y',
      '-loop',
      '1',
      '-i',
      sceneImagePath,
      '-t',
      String(Math.max(1, segment.duration_sec)),
      '-r',
      String(Math.max(1, Math.round(plan.fps || 30))),
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-crf',
      '28',
      '-pix_fmt',
      'yuv420p',
      sceneVideoPath,
    ], {
      cwd: rootDir,
      timeoutMs: 60_000,
    });
    sceneVideoPaths.push(sceneVideoPath);
  });

  safeWriteFile(
    concatListPath,
    `${sceneVideoPaths.map((sceneVideoPath) => `file '${sceneVideoPath.replace(/'/g, "'\\''")}'`).join('\n')}\n`,
    { mkdir: true, encoding: 'utf8' },
  );

  safeExec('ffmpeg', [
    '-y',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    concatListPath,
    '-c',
    'copy',
    silentPath,
  ], {
    cwd: rootDir,
    timeoutMs: 60_000,
  });

  const audioRef = resolveMuxAudioRef(plan);
  if (audioRef) {
    if (safeExistsSync(outputPath)) {
      safeRmSync(outputPath);
    }
    const muxArgs = buildMuxArgs(silentPath, audioRef, outputPath, plan.output_format, plan.duration_sec);
    safeExec('ffmpeg', muxArgs, {
      cwd: rootDir,
      timeoutMs: 60_000,
    });
  } else {
    safeMoveSync(silentPath, outputPath);
  }

  if (audioRef && (!hasRequiredStreams(outputPath, true, true) || !hasMinimumArtifactSize(outputPath, 1024))) {
    runDirectMuxRetry(rootDir, silentPath, audioRef, outputPath, plan.output_format, plan.duration_sec);
  }

  if (!safeExistsSync(outputPath)) {
    throw new Error(`Fallback render failed to produce output artifact: ${outputPath}${cause ? ` (cause: ${cause.message})` : ''}`);
  }
  if (!hasMinimumArtifactSize(outputPath, 1024)) {
    throw new Error(`Fallback render produced a suspiciously small output artifact: ${outputPath}${cause ? ` (cause: ${cause.message})` : ''}`);
  }
  if (!hasRequiredStreams(outputPath, true, audioRef ? true : false)) {
    throw new Error(`Fallback render produced an invalid container: ${outputPath}${cause ? ` (cause: ${cause.message})` : ''}`);
  }

  const backend = resolveVideoBackend('hyperframes_cli');
  return {
    executed: true,
    backend: 'ffmpeg_fallback',
    output_path: outputPath,
    command: [
      'python3',
      pathResolver.rootResolve('scripts/make_video_cover.py'),
      'ffmpeg',
      'ffmpeg',
    ],
    reason: cause ? `hyperframes backend failed; fallback rendered instead: ${cause.message}` : 'fallback render completed',
    backend_id: `${backend.backend_id}.fallback`,
    backend_kind: backend.kind,
    backend_provider: 'ffmpeg',
  };
}

function buildFallbackSegments(plan: VideoCompositionRenderPlan): Array<{
  title: string;
  subtitle: string;
  duration_sec: number;
}> {
  const scenes = plan.scenes
    .slice()
    .sort((left, right) => left.start_sec - right.start_sec);
  const baseTitle = plan.title || 'Kyberion video';
  const segmentCount = scenes.length >= 3 ? Math.min(4, scenes.length) : 3;
  const durations = distributeDuration(plan.duration_sec || segmentCount, segmentCount);
  const fallbackLabels = ['Hook', 'Why it matters', 'How it works', 'Next step'];

  if (scenes.length >= 3) {
    return Array.from({ length: segmentCount }, (_, index) => {
      const scene = scenes[index];
      return {
        title: fallbackSceneTitle(scene, fallbackLabels[index] || baseTitle, index, baseTitle),
        subtitle: fallbackSceneSubtitle(scene, index),
        duration_sec: durations[index],
      };
    });
  }

  return [
    {
      title: baseTitle,
      subtitle: fallbackSceneSubtitle(scenes[0], 0, 'intent and setup'),
      duration_sec: durations[0],
    },
    {
      title: 'Why it matters',
      subtitle: fallbackSceneSubtitle(scenes[1], 1, 'clear value in a single beat'),
      duration_sec: durations[1],
    },
    {
      title: 'Next step',
      subtitle: fallbackSceneSubtitle(scenes[2], 2, 'move from brief to render'),
      duration_sec: durations[2],
    },
  ];
}

function fallbackSceneTitle(
  scene: VideoCompositionRenderPlan['scenes'][number] | undefined,
  label: string,
  index: number,
  baseTitle: string,
): string {
  const headline = sceneText(scene, 'headline') || sceneText(scene, 'title') || sceneText(scene, 'eyebrow');
  if (headline) return truncateText(headline, 54);
  if (index === 0) return truncateText(baseTitle, 54);
  return truncateText(label, 54);
}

function fallbackSceneSubtitle(
  scene: VideoCompositionRenderPlan['scenes'][number] | undefined,
  index: number,
  fallbackText = '',
): string {
  const parts = [
    sceneText(scene, 'body'),
    sceneText(scene, 'caption'),
    sceneText(scene, 'summary'),
    sceneText(scene, 'supporting_copy'),
  ].filter(Boolean);
  const source = parts[0] || fallbackText || `Scene ${index + 1}`;
  return truncateText(source, 72);
}

function sceneText(
  scene: VideoCompositionRenderPlan['scenes'][number] | undefined,
  key: string,
): string {
  if (!scene) return '';
  const value = scene.content?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

function distributeDuration(totalDuration: number, segmentCount: number): number[] {
  const total = Math.max(segmentCount, Math.round(totalDuration || segmentCount));
  const base = Math.max(1, Math.floor(total / segmentCount));
  const durations = Array.from({ length: segmentCount }, () => base);
  let remaining = Math.max(0, total - base * segmentCount);
  let index = 0;
  while (remaining > 0) {
    durations[index % segmentCount] += 1;
    remaining -= 1;
    index += 1;
  }
  return durations;
}

function truncateText(value: string, limit: number): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (compact.length <= limit) return compact;
  return `${compact.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function resolveOutputPath(plan: VideoCompositionRenderPlan): string {
  if (plan.output_target_path && plan.output_target_path.trim()) {
    return pathResolver.rootResolve(plan.output_target_path.trim());
  }
  const ext = plan.output_format;
  return path.join(plan.bundle_dir, `output.${ext}`);
}

function resolveMuxAudioRef(plan: VideoCompositionRenderPlan): string | undefined {
  return plan.narration_ref
    || plan.music_ref
    || (plan as any).audio?.narration_ref
    || (plan as any).audio?.music_ref;
}

async function muxAudioTrack(
  outputPath: string,
  audioPath: string,
  outputFormat: VideoCompositionRenderPlan['output_format'],
  durationSec: number,
): Promise<void> {
  const tempOutputPath = buildMuxTempPath(outputPath);
  const args = buildMuxArgs(outputPath, audioPath, tempOutputPath, outputFormat, durationSec);
  await platform.runMediaCommand('ffmpeg', args);
  finalizeMuxedOutput(tempOutputPath, outputPath);
}

async function muxAudioTrackAsync(
  outputPath: string,
  audioPath: string,
  outputFormat: VideoCompositionRenderPlan['output_format'],
  durationSec: number,
): Promise<void> {
  const tempOutputPath = buildMuxTempPath(outputPath);
  const args = buildMuxArgs(outputPath, audioPath, tempOutputPath, outputFormat, durationSec);
  await platform.runMediaCommand('ffmpeg', args);
  finalizeMuxedOutput(tempOutputPath, outputPath);
}

function buildMuxArgs(
  inputVideoPath: string,
  narrationPath: string,
  outputPath: string,
  outputFormat: VideoCompositionRenderPlan['output_format'],
  durationSec: number,
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
  ];
  if (durationSec > 0) {
    args.push('-t', String(durationSec));
  }
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

function hasRequiredStreams(
  outputPath: string,
  requireVideo: boolean,
  requireAudio: boolean,
): boolean {
  try {
    if (requireVideo) {
      const videoProbe = safeExec('ffprobe', [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=index',
        '-of',
        'csv=p=0',
        outputPath,
      ]).trim();
      if (!videoProbe) return false;
    }
    if (requireAudio) {
      const audioProbe = safeExec('ffprobe', [
        '-v',
        'error',
        '-select_streams',
        'a:0',
        '-show_entries',
        'stream=index',
        '-of',
        'csv=p=0',
        outputPath,
      ]).trim();
      if (!audioProbe) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function hasMinimumArtifactSize(outputPath: string, minBytes: number): boolean {
  try {
    return safeStat(outputPath).size >= minBytes;
  } catch {
    return false;
  }
}

function buildMuxTempPath(outputPath: string): string {
  const ext = path.extname(outputPath) || '.mp4';
  const base = outputPath.slice(0, outputPath.length - ext.length);
  return `${base}.muxed${ext}`;
}

function runDirectMuxRetry(
  cwd: string,
  inputVideoPath: string,
  audioPath: string,
  outputPath: string,
  outputFormat: VideoCompositionRenderPlan['output_format'],
  durationSec: number,
): void {
  const args = buildMuxArgs(inputVideoPath, audioPath, outputPath, outputFormat, durationSec);
  const result = spawnSync('ffmpeg', args, {
    cwd,
    env: buildSafeExecEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status === 0) {
    return;
  }
  const stderr = result.stderr ? String(result.stderr).trim() : '';
  const detail = stderr ? `: ${stderr.split('\n').slice(-1)[0]}` : '';
  throw new Error(`Direct mux retry failed (code=${String(result.status)}, signal=${String(result.signal)})${detail}`);
}

async function runCancellableCommand(
  command: string,
  args: string[],
  options: {
    timeout_ms: number;
    is_cancelled?: () => boolean;
    poll_interval_ms: number;
    env?: NodeJS.ProcessEnv;
    cwd: string;
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
      cwd: options.cwd,
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
