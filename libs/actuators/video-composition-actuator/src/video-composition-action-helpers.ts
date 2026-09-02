import type { ChildProcess } from 'node:child_process';
import { authorSceneCompositions } from '@agent/core/video-scene-composition';
import { generateVideoMotionDirection } from '@agent/core/video-motion-direction';
import { generateVideoVisualDirection } from '@agent/core/video-visual-direction';
import { nowIso, readJsonIfPresent } from '@agent/core/foundation';
import {
  assertSafeRepositoryPath,
  safeExec,
  safeExecResult,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeStat,
  safeWriteFile,
} from '@agent/core/secure-io';
import { retry } from '@agent/core/async-utils';
import { compileNarratedVideoBriefToCompositionADF } from '@agent/core/narrated-video-brief-compiler';
import {
  compileVideoCompositionADF,
  writeVideoCompositionBundle,
} from '@agent/core/video-composition-compiler';
import {
  compileVideoContentBriefToStoryboard,
  compileVideoStoryboardToNarratedVideoBrief,
} from '@agent/core/video-content-brief-contract';
import { formatVideoLintReport, lintVideoComposition } from '@agent/core/video-composition-lint';
import { getVideoCompositionTemplateRegistry } from '@agent/core/video-composition-template-registry';
import { getVideoRenderRuntimePolicy } from '@agent/core/video-render-runtime-policy';
import {
  renderNarratedFallbackVideo,
  renderVideoCompositionBundleAsync,
} from '@agent/core/video-render-backend';
import { spawnManagedProcess } from '@agent/core/managed-process';
import { ensureDefaultOpPreflight } from '@agent/core/op-preflight-defaults';
import { runOpPreflightSync } from '@agent/core/op-preflight';
import { logger } from '@agent/core/core';
import { pathResolver } from '@agent/core/path-resolver';
import type { VideoCompositionADF } from '@agent/core/video-composition-contract';
import { getRegisteredEnvText } from '@agent/core/foundation';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  buildVideoRetryOptions,
  computeAwaitTimeoutMs,
  deepResolve,
  extractBackendTerminationState,
  formatCancellationMessage,
  jobDiagnostics,
  normalizeAwaitTimeoutMs,
  packetHistory,
  resolveActionParams,
  resolveAwaitCompletion,
  runtime,
  trackLifecycleDiagnostics,
  upsertJobDiagnostics,
  validateVideoCompositionAction,
  waitForRenderJob,
} from './video-composition-helpers.js';

type VideoCompositionAction =
  | VideoCompositionADF
  | {
      action: 'prepare_video_composition';
      params: { video_composition_adf: VideoCompositionADF; job_id?: string; bundle_dir?: string };
    }
  | {
      action: 'compile_narrated_video_brief';
      params: { narrated_video_brief: Record<string, unknown> };
    }
  | {
      action: 'compile_video_content_brief';
      params: { video_content_brief: Record<string, unknown> };
    }
  | {
      action: 'lint_video_composition';
      params: {
        video_composition_adf: VideoCompositionADF;
        bundle_dir?: string;
        tenant_slug?: string;
        fail_on_error?: boolean;
      };
    }
  | {
      action: 'create_narrated_video_from_content_brief';
      params: {
        video_content_brief: Record<string, unknown>;
        narration_artifact_ref: string;
        job_id?: string;
        bundle_dir?: string;
        output?: Record<string, unknown>;
      };
    }
  | {
      action: 'create_narrated_intro_movie';
      params: {
        narrated_video_brief: Record<string, unknown>;
        job_id?: string;
        bundle_dir?: string;
      };
    }
  | { action: 'list_video_composition_templates'; params: Record<string, unknown> }
  | { action: 'get_video_composition_job_status'; params: { job_id: string } }
  | { action: 'await_video_composition_job'; params: { job_id: string; timeout_ms?: number } }
  | { action: 'cancel_video_composition_job'; params: { job_id: string; reason?: string } }
  | {
      action: 'verify_rendered_video_artifact';
      params: {
        path: string;
        require_audio?: boolean;
        require_video?: boolean;
        export_as?: string;
      };
    }
  | {
      action: 'validate_narrated_video_artifact';
      params: {
        narration_path: string;
        video_output_path: string;
        video_bundle_dir: string;
        mission_evidence_dir: string;
        video_slug: string;
        tolerance_sec?: number;
        export_as?: string;
      };
    }
  | { action: 'get_video_composition_queue'; params?: Record<string, unknown> }
  | Record<string, any>;

interface VideoCompositionJobDiagnostics {
  created_at?: string;
  started_at?: string;
  finished_at?: string;
  duration_ms?: number;
  /** MP-02: set when the artifact came from a lower-fidelity render path. */
  render_degraded?: boolean;
  render_degraded_from?: string;
  render_degradation_reason?: string;
  terminal_status?: 'completed' | 'failed' | 'cancelled';
  cancellation_reason?: string;
  cancellation_requested_at?: string;
  backend_exit_signal?: string | null;
  backend_exit_code?: number | null;
  backend_cancelled?: boolean;
  backend_timed_out?: boolean;
  last_error?: string;
}

interface VideoCompositionJobTicket {
  job_id: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  created_at: string;
  updated_at: string;
  bundle_dir: string;
  output_format: string;
  output_target_path?: string;
  await_completion: boolean;
  detached_background?: boolean;
  backend_rendering_enabled: boolean;
  backend_render_backend: string;
  artifact_refs?: string[];
  rendered_output_path?: string;
  diagnostics?: VideoCompositionJobDiagnostics | null;
}

const DETACHED_WORKER_SCRIPT = pathResolver.rootResolve(
  'dist/libs/actuators/video-composition-actuator/src/index.js'
);

function resolveVideoRepositoryPath(ref: string, allowMissingLeaf = true): string {
  return assertSafeRepositoryPath(pathResolver.rootResolve(String(ref || '').trim()), {
    allowMissingLeaf,
  });
}

function writeVideoCompositionJobTicket(
  ticketPath: string,
  ticket: VideoCompositionJobTicket
): void {
  safeMkdir(path.dirname(ticketPath), { recursive: true });
  safeWriteFile(ticketPath, JSON.stringify(ticket, null, 2));
}

function readVideoCompositionJobTicket(ticketPath: string): VideoCompositionJobTicket | null {
  return readJsonIfPresent<VideoCompositionJobTicket>(ticketPath);
}

function spawnDetachedVideoCompositionWorker(inputPath: string): ChildProcess | null {
  if (!safeExistsSync(DETACHED_WORKER_SCRIPT)) {
    return null;
  }
  const handle = spawnManagedProcess({
    resourceId: `video-composition-worker:${path.basename(inputPath)}`,
    kind: 'service',
    ownerId: 'video-composition-actuator',
    ownerType: 'actuator',
    command: process.execPath,
    args: [DETACHED_WORKER_SCRIPT, '--input', inputPath],
    spawnOptions: {
      cwd: pathResolver.rootDir(),
      env: {
        ...process.env,
        KYBERION_VIDEO_RENDER_RUN_MODE: 'in-process',
      },
      detached: true,
      stdio: 'ignore',
    },
    shutdownPolicy: 'detached',
  });
  const child = handle.child;
  child.unref();
  return child;
}

runtime.subscribe((packet) => {
  trackLifecycleDiagnostics(packet);
  const history = packetHistory.get(packet.job_id) || [];
  history.push(packet);
  if (history.length > 200) history.shift();
  packetHistory.set(packet.job_id, history);
});

async function listVideoCompositionTemplates() {
  const registry = getVideoCompositionTemplateRegistry();
  return {
    status: 'succeeded',
    default_template_id: registry.default_template_id,
    templates: registry.templates,
  };
}

// agy short-video quality: after the deterministic compile, draft a
// story-matched visual direction (LLM zone). Failure never blocks the
// render — the compiler degrades to the legacy palette.
async function attachVisualDirection(adf: any, brief: Record<string, unknown>): Promise<void> {
  const reasons: string[] = [];
  try {
    const storyboard = (brief as any).storyboard;
    const story = Array.isArray(storyboard?.beats)
      ? storyboard.beats
          .map((beat: any) => `${beat?.title ?? ''} ${beat?.narration ?? beat?.summary ?? ''}`)
          .join('\n')
      : String((brief as any).narration?.script ?? (brief as any).summary ?? adf.title ?? '');
    const scope = {
      tier: brief.tier === 'personal' || brief.tier === 'confidential' ? brief.tier : 'public',
      tenant_slug: brief.tenant_slug ? String(brief.tenant_slug) : undefined,
      purpose: 'video composition direction',
    } as const;
    const sceneInputs = (adf.scenes || []).map((scene: any) => ({
      scene_id: String(scene.scene_id),
      role: scene.role,
      duration_sec: Number(scene.duration_sec),
      available_keys: Object.keys(scene.content || {}),
    }));
    adf.composition.visual_direction = await generateVideoVisualDirection({
      title: String(adf.title || 'Short video'),
      story,
      tone: (brief as any).tone ? String((brief as any).tone) : undefined,
      audience: (brief as any).audience ? String((brief as any).audience) : undefined,
      frame: { width: adf.composition.width, height: adf.composition.height },
      scene_ids: (adf.scenes || []).map((scene: any) => String(scene.scene_id)),
      scope,
    });
    adf.composition.motion_direction = await generateVideoMotionDirection({
      title: String(adf.title || 'Short video'),
      story,
      tone: (brief as any).tone ? String((brief as any).tone) : undefined,
      scenes: sceneInputs,
      scope,
    });
    adf.composition.scene_compositions = await authorSceneCompositions({
      title: String(adf.title || 'Short video'),
      story,
      scenes: sceneInputs,
      scope,
    });
    const resolutions = [
      adf.composition.visual_direction?.resolution,
      adf.composition.motion_direction?.resolution,
      ...(adf.composition.scene_compositions || []).map((scene: any) => scene.resolution),
    ].filter(Boolean);
    const degraded = resolutions.some((resolution: any) => resolution.degraded === true);
    for (const resolution of resolutions) {
      if (resolution.reason) reasons.push(String(resolution.reason).slice(0, 240));
    }
    adf.composition.art_direction_resolution = {
      degraded,
      sources: Array.from(
        new Set(resolutions.map((resolution: any) => resolution.source))
      ) as Array<'model' | 'catalog-default'>,
      ...(reasons.length > 0 ? { reasons: Array.from(new Set(reasons)).slice(0, 8) } : {}),
    };
  } catch (error: any) {
    /* art direction is best-effort; compiler falls back to defaults, but the degradation is durable. */
    adf.composition.art_direction_resolution = {
      degraded: true,
      sources: ['catalog-default'],
      reasons: [String(error?.message || error || 'art direction unavailable').slice(0, 240)],
    };
  }
}

async function compileNarratedVideoBrief(params: {
  narrated_video_brief?: Record<string, unknown>;
}) {
  if (!params.narrated_video_brief) {
    throw new Error('compile_narrated_video_brief requires params.narrated_video_brief');
  }
  const adf = compileNarratedVideoBriefToCompositionADF(params.narrated_video_brief as any);
  await attachVisualDirection(adf, params.narrated_video_brief);
  return {
    status: 'succeeded',
    kind: 'compiled_video_composition_adf',
    video_composition_adf: adf,
  };
}

async function compileVideoContentBrief(params: { video_content_brief?: Record<string, unknown> }) {
  if (!params.video_content_brief) {
    throw new Error('compile_video_content_brief requires params.video_content_brief');
  }
  const storyboard = compileVideoContentBriefToStoryboard(params.video_content_brief as any);
  return {
    status: 'succeeded',
    kind: 'compiled_video_storyboard',
    video_storyboard: storyboard,
  };
}

/**
 * MP-02: lint a composition before it is rendered.
 *
 * Reads the compiled scene HTML when a bundle exists so the determinism rules
 * apply to what will actually be seeked, not just to the contract. Errors fail
 * the step: a bundle that reads a clock cannot be reproduced, and a scene gap
 * renders as blank frames.
 */
async function lintVideoCompositionAction(params: {
  video_composition_adf?: VideoCompositionADF;
  bundle_dir?: string;
  tenant_slug?: string;
  fail_on_error?: boolean;
}) {
  if (!params.video_composition_adf) {
    throw new Error('lint_video_composition requires params.video_composition_adf');
  }
  const adf = params.video_composition_adf;
  const bundleDir = params.bundle_dir || adf.output?.bundle_dir;
  const sceneHtml: Record<string, string> = {};
  if (bundleDir) {
    const safeBundleDir = resolveVideoRepositoryPath(bundleDir);
    for (const scene of adf.scenes || []) {
      const scenePath = assertSafeRepositoryPath(
        path.join(safeBundleDir, 'compositions', `${scene.scene_id}.html`),
        { allowMissingLeaf: true }
      );
      if (safeExistsSync(scenePath)) {
        sceneHtml[scene.scene_id] = safeReadFile(scenePath, { encoding: 'utf8' }) as string;
      }
    }
  }

  const report = lintVideoComposition({
    adf,
    sceneHtml,
    ...(params.tenant_slug ? { tenantSlug: params.tenant_slug } : {}),
  });
  const failOnError = params.fail_on_error !== false;

  if (report.findings.length > 0) {
    logger.warn(`[video-lint]\n${formatVideoLintReport(report)}`);
  }
  if (!report.ok && failOnError) {
    throw new Error(
      `video composition lint failed with ${report.error_count} error(s):\n${formatVideoLintReport(report)}`
    );
  }

  return {
    status: 'succeeded',
    kind: 'video_composition_lint_report',
    lint_report: report,
    scenes_inspected: Object.keys(sceneHtml).length,
  };
}

async function createNarratedVideoFromContentBrief(params: {
  video_content_brief?: Record<string, unknown>;
  narration_artifact_ref?: string;
  job_id?: string;
  bundle_dir?: string;
  output?: Record<string, unknown>;
}) {
  if (!params.video_content_brief) {
    throw new Error('create_narrated_video_from_content_brief requires params.video_content_brief');
  }
  if (!params.narration_artifact_ref) {
    throw new Error(
      'create_narrated_video_from_content_brief requires params.narration_artifact_ref'
    );
  }
  const contentBrief = params.video_content_brief as any;
  const storyboard = compileVideoContentBriefToStoryboard(contentBrief);
  const narratedVideoBrief = compileVideoStoryboardToNarratedVideoBrief(storyboard, {
    title: contentBrief.title,
    language: contentBrief.language,
    narration_artifact_ref: params.narration_artifact_ref,
    brand_name: contentBrief.design_system_ref?.brand_name,
    theme_background_color: contentBrief.design_system_ref?.background_color,
    logo_path: contentBrief.design_system_ref?.logo_path,
    hero_path: contentBrief.design_system_ref?.hero_path,
    timing: {
      duration_sec: params.output?.duration_sec || contentBrief.duration_sec,
      fps: params.output?.fps || contentBrief.design_system_ref?.fps,
    },
    output: {
      format: (params.output?.format as any) || 'mp4',
      target_path: params.output?.target_path as string | undefined,
      bundle_dir: (params.output?.bundle_dir as string | undefined) || params.bundle_dir,
      await_completion: params.output?.await_completion as boolean | undefined,
      detached_background: params.output?.detached_background as boolean | undefined,
    },
  });
  const execution = await createNarratedIntroMovie({
    narrated_video_brief: narratedVideoBrief as any,
    job_id: params.job_id,
    bundle_dir: params.bundle_dir || (params.output?.bundle_dir as string | undefined),
  });
  return {
    status: execution.status,
    kind: 'narrated_content_brief_movie_run',
    video_storyboard: storyboard,
    narrated_video_brief: narratedVideoBrief,
    video_composition_adf: execution.video_composition_adf,
    execution,
  };
}

async function createNarratedIntroMovie(params: {
  narrated_video_brief?: Record<string, unknown>;
  job_id?: string;
  bundle_dir?: string;
}) {
  if (!params.narrated_video_brief) {
    throw new Error('create_narrated_intro_movie requires params.narrated_video_brief');
  }
  const adf = compileNarratedVideoBriefToCompositionADF(params.narrated_video_brief as any);
  await attachVisualDirection(adf, params.narrated_video_brief);
  const execution = await prepareVideoComposition({
    video_composition_adf: adf,
    job_id: params.job_id,
    bundle_dir: params.bundle_dir,
  });
  if (execution.rendered_output_path && execution.backend_rendering_enabled) {
    const requiresRepair = !(await isRenderableVideoArtifact(execution.rendered_output_path));
    if (requiresRepair) {
      const repairedPlan = compileVideoCompositionADF(adf as any);
      await renderNarratedFallbackVideo(
        repairedPlan,
        execution.rendered_output_path,
        new Error('backend render returned an invalid artifact')
      );
    }
  }
  return {
    status: execution.status,
    kind: 'narrated_intro_movie_run',
    video_composition_adf: adf,
    execution,
  };
}

async function verifyRenderedVideoArtifact(params: {
  path?: string;
  require_audio?: boolean;
  require_video?: boolean;
  export_as?: string;
}) {
  const rootDir = pathResolver.rootDir();
  const artifactPath = resolveVideoRepositoryPath(String(params.path || '').trim());
  if (!artifactPath || !safeExistsSync(artifactPath)) {
    throw new Error(
      `verify_rendered_video_artifact requires an existing path: ${String(params.path || '')}`
    );
  }

  const requireAudio = params.require_audio !== false;
  const requireVideo = params.require_video !== false;
  const probeStream = (selector: string) =>
    safeExec(
      'ffprobe',
      [
        '-v',
        'error',
        '-select_streams',
        selector,
        '-show_entries',
        'stream=index',
        '-of',
        'csv=p=0',
        artifactPath,
      ],
      {
        cwd: rootDir,
        timeoutMs: 30_000,
      }
    ).trim();

  let audioProbe = '';
  let videoProbe = '';
  if (requireAudio) {
    audioProbe = probeStream('a:0');
    if (!audioProbe) {
      throw new Error(`verify_rendered_video_artifact found no audio stream in ${artifactPath}`);
    }
  }
  if (requireVideo) {
    videoProbe = probeStream('v:0');
    if (!videoProbe) {
      throw new Error(`verify_rendered_video_artifact found no video stream in ${artifactPath}`);
    }
  }

  return {
    status: 'succeeded',
    kind: 'video_artifact_verification',
    path: artifactPath,
    has_audio: Boolean(audioProbe),
    has_video: Boolean(videoProbe),
    output: artifactPath,
  };
}

async function validateNarratedVideoArtifact(params: {
  // Dispatched from the untyped action router; every field is coerced and
  // existence-checked below, so the contract is enforced at runtime.
  narration_path?: string;
  video_output_path?: string;
  video_bundle_dir?: string;
  mission_evidence_dir?: string;
  video_slug?: string;
  tolerance_sec?: number;
  export_as?: string;
}) {
  const rootDir = pathResolver.rootDir();
  const resolveArtifactPath = (value: string) =>
    resolveVideoRepositoryPath(String(value || '').trim());
  const narrationPath = resolveArtifactPath(params.narration_path);
  const videoPath = resolveArtifactPath(params.video_output_path);
  const bundleDir = resolveArtifactPath(params.video_bundle_dir);
  const evidenceDir = resolveArtifactPath(params.mission_evidence_dir);
  const videoSlug = String(params.video_slug || '').trim();
  if (!videoSlug) throw new Error('validate_narrated_video_artifact requires video_slug');

  for (const [label, artifactPath] of [
    ['narration', narrationPath],
    ['video', videoPath],
    ['bundle index', path.join(bundleDir, 'index.html')],
    ['bundle render plan', path.join(bundleDir, 'render-plan.json')],
  ] as const) {
    if (!safeExistsSync(artifactPath)) {
      throw new Error(`validate_narrated_video_artifact missing ${label}: ${artifactPath}`);
    }
  }

  const streamVerification = await verifyRenderedVideoArtifact({
    path: videoPath,
    require_audio: true,
    require_video: true,
  });
  const frameDir = assertSafeRepositoryPath(path.join(evidenceDir, `${videoSlug}-frames`), {
    allowMissingLeaf: true,
  });
  safeMkdir(frameDir, { recursive: true });
  const framePaths = [
    path.join(frameDir, 'frame-000.png'),
    path.join(frameDir, 'frame-001.png'),
    path.join(frameDir, 'frame-002.png'),
  ];
  const frameCommands: string[][] = [
    ['-y', '-i', videoPath, '-vf', "select='eq(n,0)'", '-vframes', '1', framePaths[0]],
    ['-y', '-ss', '00:00:06', '-i', videoPath, '-vframes', '1', framePaths[1]],
    ['-y', '-ss', '00:00:11', '-i', videoPath, '-vframes', '1', framePaths[2]],
  ];
  for (const args of frameCommands) {
    safeExec('ffmpeg', args, { cwd: rootDir, timeoutMs: 120_000 });
  }
  for (const framePath of framePaths) {
    if (!safeExistsSync(framePath)) {
      throw new Error(`validate_narrated_video_artifact failed to extract frame: ${framePath}`);
    }
  }

  const blackFrameCheck = safeExecResult(
    'ffmpeg',
    [
      '-hide_banner',
      '-i',
      videoPath,
      '-vf',
      'blackdetect=d=0.5:pic_th=0.98:pix_th=0.10',
      '-an',
      '-f',
      'null',
      '-',
    ],
    { cwd: rootDir, timeoutMs: 120_000 }
  );
  if (blackFrameCheck.status !== 0) {
    throw new Error(
      `validate_narrated_video_artifact black-frame probe failed: ${blackFrameCheck.stderr.trim()}`
    );
  }
  if (`${blackFrameCheck.stdout}\n${blackFrameCheck.stderr}`.includes('black_start')) {
    throw new Error(`validate_narrated_video_artifact detected a black frame in ${videoPath}`);
  }

  const probeDuration = (artifactPath: string) => {
    const output = safeExec(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', artifactPath],
      { cwd: rootDir, timeoutMs: 30_000 }
    ).trim();
    const duration = Number(output);
    if (!Number.isFinite(duration)) {
      throw new Error(`validate_narrated_video_artifact could not read duration: ${artifactPath}`);
    }
    return duration;
  };
  const videoDurationSec = probeDuration(videoPath);
  const narrationDurationSec = probeDuration(narrationPath);
  const toleranceSec = Math.max(0, Number(params.tolerance_sec ?? 5));
  const durationDeltaSec = Math.abs(videoDurationSec - narrationDurationSec);
  if (durationDeltaSec > toleranceSec) {
    throw new Error(
      `validate_narrated_video_artifact duration mismatch: video=${videoDurationSec} audio=${narrationDurationSec} delta=${durationDeltaSec} tolerance=${toleranceSec}`
    );
  }

  return {
    status: 'succeeded',
    kind: 'narrated_video_artifact_validation',
    narration_path: narrationPath,
    video_output_path: videoPath,
    video_bundle_dir: bundleDir,
    frame_paths: framePaths,
    has_audio: streamVerification.has_audio,
    has_video: streamVerification.has_video,
    black_frame_check: 'passed',
    video_duration_sec: videoDurationSec,
    narration_duration_sec: narrationDurationSec,
    duration_delta_sec: durationDeltaSec,
    duration_tolerance_sec: toleranceSec,
    ...(params.export_as ? { export_as: params.export_as } : {}),
  };
}

async function isRenderableVideoArtifact(artifactPath: string): Promise<boolean> {
  if (!artifactPath || !safeExistsSync(artifactPath)) {
    return false;
  }

  try {
    if (safeStat(artifactPath).size < 1024) {
      return false;
    }
  } catch {
    return false;
  }

  try {
    const hasVideo = safeExec('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=index',
      '-of',
      'csv=p=0',
      artifactPath,
    ]).trim();
    if (!hasVideo) {
      return false;
    }

    const hasAudio = safeExec('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'a:0',
      '-show_entries',
      'stream=index',
      '-of',
      'csv=p=0',
      artifactPath,
    ]).trim();

    return Boolean(hasAudio);
  } catch {
    return false;
  }
}

async function getVideoCompositionJobStatus(params: { job_id?: string; job_ticket_path?: string }) {
  const jobId = String(params.job_id || '');
  if (!jobId) throw new Error('get_video_composition_job_status requires params.job_id');
  const packet = runtime.getPacket(jobId);
  if (!packet) {
    const ticketPath = params.job_ticket_path
      ? resolveVideoRepositoryPath(String(params.job_ticket_path))
      : null;
    const ticket = ticketPath ? readVideoCompositionJobTicket(ticketPath) : null;
    if (ticket) {
      return {
        status: 'succeeded',
        job_id: jobId,
        packet: ticket,
        progress_packets: packetHistory.get(jobId) || [],
        diagnostics: jobDiagnostics.get(jobId) || null,
        job_ticket_path: ticketPath,
      };
    }
    return {
      status: 'not_found',
      job_id: jobId,
      packet: null,
      progress_packets: [],
      diagnostics: null,
    };
  }
  return {
    status: 'succeeded',
    job_id: jobId,
    packet,
    progress_packets: packetHistory.get(jobId) || [],
    diagnostics: jobDiagnostics.get(jobId) || null,
  };
}

async function awaitVideoCompositionJob(params: {
  job_id?: string;
  timeout_ms?: number;
  job_ticket_path?: string;
}) {
  const jobId = String(params.job_id || '');
  if (!jobId) throw new Error('await_video_composition_job requires params.job_id');
  const timeoutMs = normalizeAwaitTimeoutMs(params.timeout_ms);
  const ticketPath = params.job_ticket_path
    ? resolveVideoRepositoryPath(String(params.job_ticket_path))
    : null;

  if (ticketPath) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const livePacket = runtime.getPacket(jobId);
      if (livePacket && ['completed', 'failed', 'cancelled'].includes(livePacket.status)) {
        return {
          status: livePacket.status === 'completed' ? 'succeeded' : livePacket.status,
          job_id: jobId,
          packet: livePacket,
          diagnostics: jobDiagnostics.get(jobId) || null,
          progress_packets: packetHistory.get(jobId) || [],
          job_ticket_path: ticketPath,
        };
      }
      const ticket = readVideoCompositionJobTicket(ticketPath);
      if (ticket && ['completed', 'failed', 'cancelled'].includes(ticket.status)) {
        return {
          status: ticket.status === 'completed' ? 'succeeded' : ticket.status,
          job_id: jobId,
          packet: ticket,
          diagnostics: jobDiagnostics.get(jobId) || null,
          progress_packets: packetHistory.get(jobId) || [],
          job_ticket_path: ticketPath,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return {
      status: 'timeout',
      job_id: jobId,
      timeout_ms: timeoutMs,
      packet: runtime.getPacket(jobId) || readVideoCompositionJobTicket(ticketPath),
      diagnostics: jobDiagnostics.get(jobId) || null,
      job_ticket_path: ticketPath,
    };
  }
  const packet = await waitForRenderJob(runtime, jobId, timeoutMs, true);
  if (!packet) {
    return {
      status: 'timeout',
      job_id: jobId,
      timeout_ms: timeoutMs,
      packet: runtime.getPacket(jobId),
      diagnostics: jobDiagnostics.get(jobId) || null,
      job_ticket_path: ticketPath,
    };
  }
  return {
    status: 'succeeded',
    job_id: jobId,
    packet,
    diagnostics: jobDiagnostics.get(jobId) || null,
    progress_packets: packetHistory.get(jobId) || [],
    job_ticket_path: ticketPath || undefined,
  };
}

async function cancelVideoCompositionJob(params: { job_id?: string; reason?: string }) {
  const jobId = String(params.job_id || '');
  if (!jobId) throw new Error('cancel_video_composition_job requires params.job_id');
  const reason =
    params.reason && String(params.reason).trim() ? String(params.reason).trim() : undefined;
  if (reason) {
    upsertJobDiagnostics(jobId, {
      cancellation_reason: reason,
      cancellation_requested_at: nowIso(),
    });
  }
  const cancellation = runtime.cancel(jobId, { reason });
  return {
    status: cancellation ? 'succeeded' : 'not_found',
    job_id: jobId,
    cancellation,
    packet: runtime.getPacket(jobId),
    diagnostics: jobDiagnostics.get(jobId) || null,
  };
}

async function getVideoCompositionQueue() {
  return {
    status: 'succeeded',
    queue: runtime.getQueueSnapshot(),
  };
}

async function prepareVideoComposition(params: {
  video_composition_adf?: VideoCompositionADF;
  job_id?: string;
  bundle_dir?: string;
}) {
  if (!params.video_composition_adf) {
    throw new Error('prepare_video_composition requires params.video_composition_adf');
  }

  const adf = params.video_composition_adf;
  const policy = getVideoRenderRuntimePolicy();
  const jobId = String(params.job_id || randomUUID());
  const awaitCompletion = resolveAwaitCompletion(adf, policy);
  const bundlePreview = compileVideoCompositionADF(adf, { bundleDir: params.bundle_dir });
  const jobTicketPath = path.join(bundlePreview.bundle_dir, 'job-state.json');
  const runMode = String(getRegisteredEnvText('KYBERION_VIDEO_RENDER_RUN_MODE') || 'foreground');
  const detachedBackground =
    adf.output?.detached_background === true &&
    awaitCompletion === false &&
    policy.render.enable_backend_rendering &&
    runMode !== 'in-process';
  upsertJobDiagnostics(jobId, { created_at: nowIso() });
  writeVideoCompositionJobTicket(jobTicketPath, {
    job_id: jobId,
    status: 'queued',
    created_at: nowIso(),
    updated_at: nowIso(),
    bundle_dir: bundlePreview.bundle_dir,
    output_format: adf.output.format,
    output_target_path: adf.output.target_path,
    await_completion: awaitCompletion,
    detached_background: adf.output?.detached_background,
    backend_rendering_enabled: policy.render.enable_backend_rendering,
    backend_render_backend: policy.render.backend,
    diagnostics: jobDiagnostics.get(jobId) || null,
  });

  if (detachedBackground) {
    const requestPath = path.join(bundlePreview.bundle_dir, 'job-request.json');
    const requestPayload = {
      action: 'prepare_video_composition',
      params: {
        video_composition_adf: {
          ...adf,
          output: {
            ...adf.output,
            await_completion: false,
            detached_background: false,
          },
        },
        job_id: jobId,
        bundle_dir: bundlePreview.bundle_dir,
      },
    };
    safeWriteFile(requestPath, JSON.stringify(requestPayload, null, 2));
    const child = spawnDetachedVideoCompositionWorker(requestPath);
    if (!child) {
      logger.warn(
        `[VIDEO_COMPOSITION] Detached worker unavailable, falling back to in-process queue for ${jobId}`
      );
    } else {
      return {
        status: 'queued',
        job_id: jobId,
        job_ticket_path: jobTicketPath,
        await_completion: false,
        await_completion_reason: 'detached background worker launched',
        packet: runtime.getPacket(jobId),
        queue: runtime.getQueueSnapshot(),
        diagnostics: jobDiagnostics.get(jobId) || null,
        output_format: adf.output.format,
        output_target_path: adf.output.target_path,
        backend_rendering_enabled: policy.render.enable_backend_rendering,
        backend_render_backend: policy.render.backend,
        bundle_dir: bundlePreview.bundle_dir,
        detached_background: true,
      };
    }
  }

  runtime.enqueue({
    jobId,
    async run(api) {
      try {
        const totalSteps = policy.render.enable_backend_rendering ? 5 : 4;
        api.report({
          status: 'validating_contract',
          progress: {
            current: 1,
            total: totalSteps,
            percent: (1 / totalSteps) * 100,
            unit: 'steps',
          },
          message: 'validated video composition contract',
        });
        api.report({
          status: 'resolving_templates',
          progress: {
            current: 2,
            total: totalSteps,
            percent: (2 / totalSteps) * 100,
            unit: 'steps',
          },
          message: `resolved ${adf.scenes.length} scene template(s)`,
        });
        api.report({
          status: 'assembling_bundle',
          progress: {
            current: 3,
            total: totalSteps,
            percent: (3 / totalSteps) * 100,
            unit: 'steps',
          },
          message: 'assembling deterministic composition bundle',
        });

        const plan = await retry(
          async () => writeVideoCompositionBundle(adf, { bundleDir: bundlePreview.bundle_dir }),
          buildVideoRetryOptions()
        );
        let artifactRefs = [...plan.artifact_refs];
        let backendOutputPath: string | undefined;
        writeVideoCompositionJobTicket(jobTicketPath, {
          job_id: jobId,
          status: 'running',
          created_at: jobDiagnostics.get(jobId)?.created_at || nowIso(),
          updated_at: nowIso(),
          bundle_dir: plan.bundle_dir,
          output_format: adf.output.format,
          output_target_path: adf.output.target_path,
          await_completion: awaitCompletion,
          backend_rendering_enabled: policy.render.enable_backend_rendering,
          backend_render_backend: policy.render.backend,
          artifact_refs: artifactRefs,
          diagnostics: jobDiagnostics.get(jobId) || null,
        });

        if (policy.render.enable_backend_rendering) {
          if (api.isCancelled()) throw new Error('video composition job cancelled');
          api.report({
            status: 'rendering',
            progress: {
              current: 4,
              total: totalSteps,
              percent: (4 / totalSteps) * 100,
              unit: 'steps',
            },
            message: `rendering composed video via backend ${policy.render.backend}`,
            artifact_refs: artifactRefs,
          });

          let backendResult: any;
          try {
            backendResult = await retry(
              async () =>
                renderVideoCompositionBundleAsync(plan, policy, {
                  isCancelled: api.isCancelled,
                }),
              buildVideoRetryOptions()
            );
          } catch (error: any) {
            const backendState = extractBackendTerminationState(error);
            if (backendState) {
              upsertJobDiagnostics(jobId, backendState);
            }
            if (api.isCancelled() || backendState?.backend_cancelled) {
              api.report({
                status: 'cancelled',
                progress: {
                  current: 4,
                  total: totalSteps,
                  percent: (4 / totalSteps) * 100,
                  unit: 'steps',
                },
                message: formatCancellationMessage(jobId),
                artifact_refs: artifactRefs,
              });
              throw new Error('video composition job cancelled');
            }
            throw error;
          }
          if (backendResult.output_path) {
            backendOutputPath = backendResult.output_path;
            artifactRefs = [...artifactRefs, backendOutputPath];
          }
          // MP-02: a fallback render still produces a file, so without
          // recording the downgrade the job reads as a clean success and a
          // still-image slideshow ships as if it were the requested render.
          if (backendResult.degraded) {
            upsertJobDiagnostics(jobId, {
              render_degraded: true,
              render_degraded_from: backendResult.degraded_from,
              render_degradation_reason: backendResult.degradation_reason,
            });
          }
          writeVideoCompositionJobTicket(jobTicketPath, {
            job_id: jobId,
            status: 'completed',
            created_at: jobDiagnostics.get(jobId)?.created_at || nowIso(),
            updated_at: nowIso(),
            bundle_dir: plan.bundle_dir,
            output_format: adf.output.format,
            output_target_path: adf.output.target_path,
            await_completion: awaitCompletion,
            backend_rendering_enabled: policy.render.enable_backend_rendering,
            backend_render_backend: policy.render.backend,
            artifact_refs: artifactRefs,
            rendered_output_path: backendOutputPath,
            diagnostics: jobDiagnostics.get(jobId) || null,
          });

          if (api.isCancelled()) throw new Error('video composition job cancelled');
          api.report({
            status: 'encoding',
            progress: { current: 5, total: totalSteps, percent: 100, unit: 'steps' },
            message: backendResult.degraded
              ? `backend render DEGRADED: ${backendResult.degradation_reason}`
              : backendResult.executed
                ? 'backend render completed'
                : backendResult.reason || 'backend skipped',
            artifact_refs: artifactRefs,
          });
        } else {
          api.report({
            status: 'rendering',
            progress: { current: 4, total: totalSteps, percent: 100, unit: 'steps' },
            message: 'bundle prepared; backend rendering remains disabled by policy',
            artifact_refs: artifactRefs,
          });
        }

        writeVideoCompositionJobTicket(jobTicketPath, {
          job_id: jobId,
          status: 'completed',
          created_at: jobDiagnostics.get(jobId)?.created_at || nowIso(),
          updated_at: nowIso(),
          bundle_dir: plan.bundle_dir,
          output_format: adf.output.format,
          output_target_path: adf.output.target_path,
          await_completion: awaitCompletion,
          backend_rendering_enabled: policy.render.enable_backend_rendering,
          backend_render_backend: policy.render.backend,
          artifact_refs: artifactRefs,
          rendered_output_path: backendOutputPath,
          diagnostics: jobDiagnostics.get(jobId) || null,
        });

        return { artifactRefs, backendOutputPath };
      } catch (error: any) {
        writeVideoCompositionJobTicket(jobTicketPath, {
          job_id: jobId,
          status: api.isCancelled() ? 'cancelled' : 'failed',
          created_at: jobDiagnostics.get(jobId)?.created_at || nowIso(),
          updated_at: nowIso(),
          bundle_dir: bundlePreview.bundle_dir,
          output_format: adf.output.format,
          output_target_path: adf.output.target_path,
          await_completion: awaitCompletion,
          backend_rendering_enabled: policy.render.enable_backend_rendering,
          backend_render_backend: policy.render.backend,
          diagnostics: jobDiagnostics.get(jobId) || null,
        });
        throw error;
      }
    },
  });

  if (!awaitCompletion) {
    return {
      status: 'queued',
      job_id: jobId,
      job_ticket_path: jobTicketPath,
      await_completion: false,
      await_completion_reason: policy.render.enable_backend_rendering
        ? 'backend rendering enabled: default asynchronous mode'
        : 'operator selected asynchronous mode',
      packet: runtime.getPacket(jobId),
      queue: runtime.getQueueSnapshot(),
      diagnostics: jobDiagnostics.get(jobId) || null,
      output_format: adf.output.format,
      output_target_path: adf.output.target_path,
      backend_rendering_enabled: policy.render.enable_backend_rendering,
      backend_render_backend: policy.render.backend,
      bundle_dir: bundlePreview.bundle_dir,
      detached_background: false,
    };
  }

  const finalPacket = await waitForRenderJob(runtime, jobId, computeAwaitTimeoutMs(policy));
  if (!finalPacket) {
    return {
      status: 'timeout',
      job_id: jobId,
      timeout_ms: computeAwaitTimeoutMs(policy),
      packet: runtime.getPacket(jobId),
      diagnostics: jobDiagnostics.get(jobId) || null,
      output_format: adf.output.format,
      backend_rendering_enabled: policy.render.enable_backend_rendering,
      backend_render_backend: policy.render.backend,
    };
  }
  const renderedOutputPath = (finalPacket.artifact_refs || []).find((ref: string) =>
    ref.endsWith(`.${adf.output.format}`)
  );
  const backendRendered = Boolean(policy.render.enable_backend_rendering && renderedOutputPath);
  return {
    status: finalPacket.status === 'completed' ? 'succeeded' : finalPacket.status,
    job_id: jobId,
    artifact_refs: finalPacket.artifact_refs || [],
    progress_packets: packetHistory.get(jobId) || [],
    diagnostics: jobDiagnostics.get(jobId) || null,
    output_format: adf.output.format,
    backend_rendering_enabled: policy.render.enable_backend_rendering,
    backend_render_backend: policy.render.backend,
    backend_rendered: backendRendered,
    rendered_output_path: renderedOutputPath,
  };
}

export async function handleSingleAction(input: VideoCompositionAction) {
  const actionName = String((input as any).action || (input as any).kind || 'unknown');
  ensureDefaultOpPreflight();
  const hasNestedParams = Boolean(
    (input as any).params && typeof (input as any).params === 'object'
  );
  const preflight = runOpPreflightSync({
    op: `video-composition:${actionName}`,
    params: (hasNestedParams ? (input as any).params : input) as Record<string, unknown>,
    source: 'actuator',
  });
  if (preflight.decision !== 'allow') {
    throw new Error(
      `[OP_PREFLIGHT_${preflight.decision.toUpperCase()}] ${preflight.reason || `Operation video-composition:${actionName} was not admitted.`}`
    );
  }
  input = (
    hasNestedParams
      ? { ...(input as any), params: preflight.input }
      : {
          ...(input as any),
          ...preflight.input,
          action: (input as any).action,
          kind: (input as any).kind,
        }
  ) as VideoCompositionAction;
  if ((input as any).kind === 'video-composition-adf') {
    return prepareVideoComposition({
      video_composition_adf: input as VideoCompositionADF,
    });
  }
  const action = (input as any).action;
  const params = resolveActionParams(input);
  if (action === 'prepare_video_composition') {
    return prepareVideoComposition(params);
  }
  if (action === 'compile_narrated_video_brief') {
    return compileNarratedVideoBrief(params);
  }
  if (action === 'compile_video_content_brief') {
    return compileVideoContentBrief(params);
  }
  if (action === 'lint_video_composition') {
    return lintVideoCompositionAction(params);
  }
  if (action === 'create_narrated_video_from_content_brief') {
    return createNarratedVideoFromContentBrief(params);
  }
  if (action === 'create_narrated_intro_movie') {
    return createNarratedIntroMovie(params);
  }
  if (action === 'verify_rendered_video_artifact') {
    return verifyRenderedVideoArtifact(params);
  }
  if (action === 'validate_narrated_video_artifact') {
    return validateNarratedVideoArtifact(params);
  }
  if (action === 'list_video_composition_templates') {
    return listVideoCompositionTemplates();
  }
  if (action === 'get_video_composition_job_status') {
    return getVideoCompositionJobStatus(params);
  }
  if (action === 'await_video_composition_job') {
    return awaitVideoCompositionJob(params);
  }
  if (action === 'cancel_video_composition_job') {
    return cancelVideoCompositionJob(params);
  }
  if (action === 'get_video_composition_queue') {
    return getVideoCompositionQueue();
  }
  throw new Error(
    `Unsupported video composition action: ${String((input as any)?.action || (input as any)?.kind)}`
  );
}

export async function handleAction(input: VideoCompositionAction) {
  validateVideoCompositionAction(input);
  if ((input as any).action === 'pipeline') {
    const results = [];
    for (const step of (input as any).steps) {
      validateVideoCompositionAction(step);
      results.push(await handleSingleAction(step));
    }
    return { status: 'succeeded', results };
  }
  return handleSingleAction(input);
}

export async function dispatchVideoCompositionOperation(
  op: string,
  params: Record<string, unknown>,
  ctx: Record<string, unknown>
): Promise<{ handled: boolean; ctx: Record<string, unknown> }> {
  const resolvedParams = deepResolve(params, ctx);
  const payload = { action: op, ...(resolvedParams || {}) };
  const result = await handleSingleAction(payload as any);
  const exportAs = String((resolvedParams as any)?.export_as || '').trim();
  return {
    handled: true,
    ctx: exportAs ? { ...ctx, [exportAs]: result } : { ...ctx, last_video_result: result },
  };
}
