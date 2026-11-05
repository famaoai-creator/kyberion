/**
 * Direct-API video generation: provider selection, request normalization,
 * submission/status/artifact execution, and governed backend resolution.
 * Provider classes live under ./providers/, adapter seam in ./provider-registry.ts,
 * governance admission in ./admission.ts, shared HTTP/env helpers in ./provider-support.ts.
 */
import { logger } from '@agent/core/core';
import { hostNodePlatform } from '@agent/core/platform-facts';
import {
  getMediaBackendRecord,
  listMediaBackends,
  probeMediaBackendAvailability,
  type MediaBackendRecord,
} from '@agent/core/media/media-backend-registry';
import {
  explainSeamProviderDecision,
  listSeamSelectionPurposes,
  resolveSeamProviderDecision,
  type ResolveSeamProviderOptions,
  type SeamProviderCandidate,
} from '@agent/core/seam-provider-selection';
import { matchSeamSelectionRule } from '@agent/core/seam-selection-rules';
import { savedSeamDefaultFor } from '@agent/core/seam-provider-selection';
import { sleep } from '@agent/core/async-utils';
import { stopExternalOperationForVerification } from '@agent/core/governance/external-operation';
import { governVideoProvider } from './admission.js';
import { getDirectVideoProviderAdapter } from './builtin-adapters.js';
import { isJsonRecord, writeArtifact } from './provider-support.js';
import type {
  DirectVideoFeatures,
  VideoGenerationJsonRecord,
  VideoGenerationArtifact,
  VideoGenerationParams,
  VideoGenerationProvider,
  VideoGenerationRequest,
  VideoGenerationStatus,
} from './types.js';
import { VIDEO_GENERATION_PROVIDER_SEAM } from './types.js';

export * from './types.js';
export {
  assertDirectVideoProviderAdapter,
  registerDirectVideoProviderAdapter,
} from './provider-registry.js';
export {
  ensureDirectVideoProviderAdapters,
  getDirectVideoProviderAdapter,
} from './builtin-adapters.js';
export { governVideoProvider } from './admission.js';

export function isDirectVideoGenerationBackend(backend: MediaBackendRecord): boolean {
  return (
    backend.modality === 'video' &&
    backend.kind === 'api' &&
    Boolean(getDirectVideoProviderAdapter(backend.provider))
  );
}

export function resolveVideoGenerationBackend(params: VideoGenerationParams): MediaBackendRecord {
  const backendId = String(params.backend_id || params.video_adf?.engine?.backend_id || '').trim();
  if (!backendId) return getMediaBackendRecord(undefined, 'video');

  const backend = listMediaBackends('video').find(
    (entry) => entry.backend_id === backendId || entry.aliases?.includes(backendId)
  );
  if (!backend) {
    throw new Error(`No registered video-generation backend matches backend_id '${backendId}'`);
  }
  return getMediaBackendRecord(backend.backend_id, 'video');
}

function assertVideoGenerationProvider(
  providerId: string,
  candidate: unknown
): asserts candidate is VideoGenerationProvider {
  if (
    !isJsonRecord(candidate) ||
    candidate.provider !== providerId ||
    typeof candidate.submit !== 'function' ||
    typeof candidate.status !== 'function' ||
    typeof candidate.download !== 'function' ||
    (candidate.cancel !== undefined && typeof candidate.cancel !== 'function')
  ) {
    throw new Error(
      'Video provider adapter ' + providerId + ' created an invalid provider contract'
    );
  }
}
export function createVideoGenerationProvider(
  backend: MediaBackendRecord
): VideoGenerationProvider {
  const adapter = getDirectVideoProviderAdapter(backend.provider);
  if (!adapter)
    throw new Error(`No video generation provider adapter registered for ${backend.provider}`);
  const provider: unknown = adapter.create();
  assertVideoGenerationProvider(backend.provider, provider);
  return governVideoProvider(provider);
}

export function normalizeVideoGenerationRequest(
  params: VideoGenerationParams,
  backend: MediaBackendRecord
): VideoGenerationRequest {
  const prompt = String(params.prompt || params.video_adf?.prompt || '').trim();
  if (!prompt) throw new Error('Direct video generation requires params.prompt');
  const model = String(params.model || params.video_model || backend.model || '').trim();
  if (!model) throw new Error(`Video backend ${backend.backend_id} requires a model identifier`);
  const referenceImages = Array.isArray(params.reference_images)
    ? params.reference_images.filter((value: unknown): value is string => typeof value === 'string')
    : [];
  return {
    prompt,
    model,
    duration_seconds:
      Number(
        params.duration_seconds || params.duration || params.video_adf?.output?.duration_seconds
      ) || undefined,
    resolution: typeof params.resolution === 'string' ? params.resolution : undefined,
    aspect_ratio: typeof params.aspect_ratio === 'string' ? params.aspect_ratio : undefined,
    first_frame_image:
      typeof params.first_frame_image === 'string' ? params.first_frame_image : undefined,
    last_frame_image:
      typeof params.last_frame_image === 'string' ? params.last_frame_image : undefined,
    reference_images: referenceImages.length ? referenceImages : undefined,
    input_video: typeof params.input_video === 'string' ? params.input_video : undefined,
    generate_audio: typeof params.generate_audio === 'boolean' ? params.generate_audio : undefined,
    target_path: typeof params.target_path === 'string' ? params.target_path : undefined,
    egress_tier: params.egress_tier,
    tenant_slug: typeof params.tenant_slug === 'string' ? params.tenant_slug : undefined,
  };
}

export async function executeDirectVideoGeneration(
  params: VideoGenerationParams
): Promise<Record<string, unknown>> {
  const backend = resolveVideoGenerationBackend(params);
  if (!isDirectVideoGenerationBackend(backend)) {
    throw new Error(`Backend ${backend.backend_id} is not a direct API video generation backend`);
  }
  const provider = createVideoGenerationProvider(backend);
  const request = normalizeVideoGenerationRequest(params, backend);
  const submission = await provider.submit(request);
  const awaitCompletion = params.await_completion === true;
  if (!awaitCompletion) {
    return {
      status: submission.status,
      provider_job_id: submission.provider_job_id,
      prompt_id: submission.provider_job_id,
      backend_id: backend.backend_id,
      backend_kind: backend.kind,
      backend_provider: backend.provider,
      modality: 'video',
      ...(submission.metadata ? { provider_metadata: submission.metadata } : {}),
    };
  }
  try {
    const completed = await waitForVideoGeneration(
      provider,
      submission.provider_job_id,
      request,
      params
    );
    const artifact = await collectDirectVideoArtifact(provider, completed, request);
    return {
      status: 'succeeded',
      provider_job_id: submission.provider_job_id,
      prompt_id: submission.provider_job_id,
      artifact,
      artifacts: [artifact],
      output_path: artifact.path,
      copied_to: artifact.path,
      backend_id: backend.backend_id,
      backend_kind: backend.kind,
      backend_provider: backend.provider,
      modality: 'video',
      ...(completed.metadata ? { provider_metadata: completed.metadata } : {}),
    };
  } catch (error) {
    stopExternalOperationForVerification(`media:video:${provider.provider}:submit`, error);
  }
}

export async function refreshDirectVideoGeneration(
  params: VideoGenerationParams,
  providerJobId: string
): Promise<Record<string, unknown>> {
  const backend = resolveVideoGenerationBackend(params);
  const provider = createVideoGenerationProvider(backend);
  const request = normalizeVideoGenerationRequest(params, backend);
  const status = await provider.status(providerJobId, request);
  if (status.status !== 'succeeded')
    return {
      ...status,
      backend_id: backend.backend_id,
      backend_provider: backend.provider,
      ...(status.metadata ? { provider_metadata: status.metadata } : {}),
    };
  const artifact = await collectDirectVideoArtifact(provider, status, request);
  return {
    ...status,
    artifact,
    artifacts: [artifact],
    output_path: artifact.path,
    copied_to: artifact.path,
    backend_id: backend.backend_id,
    backend_kind: backend.kind,
    backend_provider: backend.provider,
    modality: 'video',
    ...(status.metadata ? { provider_metadata: status.metadata } : {}),
  };
}

async function waitForVideoGeneration(
  provider: VideoGenerationProvider,
  providerJobId: string,
  request: VideoGenerationRequest,
  params: VideoGenerationParams
): Promise<VideoGenerationStatus> {
  const timeoutMs = Number(params.timeout_ms || 15 * 60 * 1000);
  const pollIntervalMs = Number(params.poll_interval_ms || 5_000);
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const current = await provider.status(providerJobId, request);
    if (current.status === 'succeeded') return current;
    if (current.status === 'failed' || current.status === 'canceled') {
      throw new Error(current.error || `Video provider job ${providerJobId} ${current.status}`);
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(`Timed out waiting for video provider job ${providerJobId}`);
}

async function collectDirectVideoArtifact(
  provider: VideoGenerationProvider,
  status: VideoGenerationStatus,
  request: VideoGenerationRequest
): Promise<VideoGenerationArtifact> {
  const bytes = await provider.download(status, request);
  return writeArtifact(request, status.provider_job_id, bytes);
}

export async function collectDirectVideoArtifactForJob(
  params: VideoGenerationParams,
  providerJobId: string
): Promise<Record<string, unknown>> {
  const backend = resolveVideoGenerationBackend(params);
  const provider = createVideoGenerationProvider(backend);
  const request = normalizeVideoGenerationRequest(params, backend);
  const status = await provider.status(providerJobId, request);
  if (status.status !== 'succeeded') return { ...status };
  const artifact = await collectDirectVideoArtifact(provider, status, request);
  return {
    ...status,
    artifact,
    artifacts: [artifact],
    copied_to: artifact.path,
    output_path: artifact.path,
  };
}

function textParam(params: VideoGenerationJsonRecord, key: string): string | undefined {
  const value = params[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function explicitVideoBackendId(params: VideoGenerationParams): string {
  return String(params.backend_id || params.video_adf?.engine?.backend_id || '').trim();
}

function frameUnmet(
  name: 'first_frame_image' | 'last_frame_image',
  value: string | undefined,
  support: DirectVideoFeatures['first_frame_image'],
  provider: string
): string | null {
  if (!value) return null;
  if (!support) return `${name} (not sent by the ${provider} adapter)`;
  if (support === 'data_uri' && !value.startsWith('data:')) return `${name} must be a data: URI`;
  return null;
}

/**
 * Text-to-video candidates for a request (hyperframes is render-only and
 * never a candidate): governed API backends with direct adapters plus
 * service presets handled by the media-generation workflow runtime. Eligible
 * means the request's features are supported and the backend is available.
 */
export async function listVideoGenerationCandidates(
  params: VideoGenerationParams,
  platform: NodeJS.Platform = hostNodePlatform()
): Promise<SeamProviderCandidate[]> {
  const firstFrame = textParam(params, 'first_frame_image');
  const lastFrame = textParam(params, 'last_frame_image');
  const aspectRatio = textParam(params, 'aspect_ratio');
  const resolution = textParam(params, 'resolution');
  const wantsAudio = params.generate_audio === true;
  const referenceImages =
    Array.isArray(params.reference_images) && params.reference_images.length > 0;
  const inputVideo = Boolean(textParam(params, 'input_video'));
  const hasWorkflow = Boolean(params.workflow || params.workflow_path || params.video_adf);

  const candidates: SeamProviderCandidate[] = [];
  for (const backend of listMediaBackends('video')) {
    const direct = isDirectVideoGenerationBackend(backend);
    const workflowPreset =
      backend.kind === 'service_preset' &&
      backend.service_id === 'media-generation' &&
      backend.action === 'generate_video';
    if (!direct && !workflowPreset) continue;
    const unmet: string[] = [];
    if (direct) {
      const features = getDirectVideoProviderAdapter(backend.provider)!.features;
      const first = frameUnmet(
        'first_frame_image',
        firstFrame,
        features.first_frame_image,
        backend.provider
      );
      if (first) unmet.push(first);
      else if (!firstFrame && features.requires_first_frame)
        unmet.push(features.requires_first_frame);
      const last = frameUnmet(
        'last_frame_image',
        lastFrame,
        features.last_frame_image,
        backend.provider
      );
      if (last) unmet.push(last);
      if (aspectRatio && !resolution) {
        if (!features.aspect_ratios) {
          unmet.push(`aspect_ratio (the ${backend.provider} adapter sends resolution only)`);
        } else if (!features.aspect_ratios.includes(aspectRatio)) {
          unmet.push(`aspect_ratio ${aspectRatio} (supports ${features.aspect_ratios.join(', ')})`);
        }
      }
      if (referenceImages) unmet.push('reference_images (not sent by any direct adapter)');
      if (inputVideo) unmet.push('input_video (not sent by any direct adapter)');
    } else {
      if (!hasWorkflow) {
        unmet.push(
          'needs params.workflow, workflow_path or video_adf (service presets run workflows)'
        );
      }
      if (firstFrame || lastFrame)
        unmet.push('first/last frame images (not passed to service preset workflows)');
    }
    if (wantsAudio && !backend.supports.mux_audio) unmet.push('generate_audio (no native audio)');
    if (unmet.length === 0) {
      const availability = await probeMediaBackendAvailability(
        backend.backend_id,
        'video',
        platform
      );
      if (!availability.available) unmet.push(`unavailable (${availability.reason})`);
    }
    candidates.push({ id: backend.backend_id, eligible: unmet.length === 0, unmet });
  }
  return candidates;
}

/** Request facts operator rules may match on. */
function videoSelectionContext(params: VideoGenerationParams): Record<string, string> {
  const context: Record<string, string> = {};
  const aspectRatio = textParam(params, 'aspect_ratio');
  if (aspectRatio) context.aspect_ratio = aspectRatio;
  if (typeof params.generate_audio === 'boolean') context.audio = String(params.generate_audio);
  if (textParam(params, 'first_frame_image')) context.image_to_video = 'true';
  return context;
}

/**
 * Purpose-driven video provider choice (seam `video-generation-provider`).
 * A named backend (backend_id / video_adf.engine.backend_id) always wins.
 * With a purpose, eligible backends are ranked by the governed policy; without
 * one, an operator rule matching the request picks a backend (a mission
 * pin it produced is reused), else an eligible saved seam default
 * (seam-selection-defaults) — otherwise the request is returned unchanged. The choice is written
 * back as `backend_id`, so submission, job refresh and artifact collection all
 * address the same backend.
 */
export async function applyVideoProviderSelection<T extends VideoGenerationParams>(
  params: T
): Promise<T> {
  if (explicitVideoBackendId(params)) return params;
  const purpose = textParam(params, 'purpose');
  const context = videoSelectionContext(params);
  if (
    !purpose &&
    !matchSeamSelectionRule(VIDEO_GENERATION_PROVIDER_SEAM, { context }) &&
    !savedSeamDefaultFor(VIDEO_GENERATION_PROVIDER_SEAM)
  ) {
    return params;
  }
  if (purpose) {
    const known = listSeamSelectionPurposes(VIDEO_GENERATION_PROVIDER_SEAM);
    if (!known.includes(purpose)) {
      throw new Error(
        `[VIDEO_GENERATION_SELECTION] unknown purpose '${purpose}' for seam '${VIDEO_GENERATION_PROVIDER_SEAM}' (known: ${known.join(', ')})`
      );
    }
  }
  const options: ResolveSeamProviderOptions = {
    seam: VIDEO_GENERATION_PROVIDER_SEAM,
    candidates: await listVideoGenerationCandidates(params),
    ...(purpose ? { purpose } : {}),
    context,
    decisionKey: purpose || 'default',
  };
  // A matching rule whose backends are all ineligible, or an ineligible saved
  // default, leaves the request unchanged (policy/builtin default applies).
  if (!purpose) {
    const preview = explainSeamProviderDecision(options);
    const savedDefaultWins =
      preview.strategy === 'default' &&
      preview.default_source !== undefined &&
      preview.default_source !== 'policy' &&
      preview.default_source !== 'caller';
    if (preview.strategy !== 'rule' && preview.strategy !== 'pinned' && !savedDefaultWins) {
      return params;
    }
  }
  const decision = resolveSeamProviderDecision(options);
  if (!decision.provider_id) {
    throw new Error(`[VIDEO_GENERATION_SELECTION] ${decision.rationale}`);
  }
  logger.info(
    `[video_generation_provider] backend '${decision.provider_id}' selected (${decision.strategy}): ${decision.rationale}`
  );
  return { ...params, backend_id: decision.provider_id };
}
