import {
  getMediaBackendRecord,
  pathResolver,
  safeMkdir,
  safeWriteFile,
  secureFetch,
  sleep,
  type MediaBackendRecord,
} from '@agent/core';
import * as path from 'node:path';

export type VideoProviderStatus = 'submitted' | 'running' | 'succeeded' | 'failed' | 'canceled';

export interface VideoGenerationRequest {
  prompt: string;
  model: string;
  duration_seconds?: number;
  resolution?: string;
  aspect_ratio?: string;
  first_frame_image?: string;
  last_frame_image?: string;
  reference_images?: string[];
  input_video?: string;
  generate_audio?: boolean;
  target_path?: string;
  egress_tier?: 'public' | 'confidential' | 'personal';
  tenant_slug?: string;
}

export interface VideoGenerationSubmission {
  provider_job_id: string;
  status: VideoProviderStatus;
  provider: string;
  metadata?: Record<string, unknown>;
}

export interface VideoGenerationStatus {
  provider_job_id: string;
  status: VideoProviderStatus;
  provider: string;
  output_url?: string;
  file_id?: string;
  inline_video_base64?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface VideoGenerationArtifact {
  kind: 'video';
  filename: string;
  type: 'output';
  path: string;
}

export interface VideoGenerationProvider {
  readonly provider: string;
  submit(request: VideoGenerationRequest): Promise<VideoGenerationSubmission>;
  status(providerJobId: string, request?: VideoGenerationRequest): Promise<VideoGenerationStatus>;
  download(status: VideoGenerationStatus, request?: VideoGenerationRequest): Promise<Buffer>;
  cancel?(providerJobId: string): Promise<void>;
}

type JsonRecord = Record<string, unknown>;

type VideoGenerationParams = JsonRecord & {
  video_adf?: {
    prompt?: unknown;
    engine?: { backend_id?: unknown };
    output?: { duration_seconds?: unknown };
  };
  egress_tier?: VideoGenerationRequest['egress_tier'];
};

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function requireEnv(...names: string[]): string {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  throw new Error(`Video provider credential is missing. Set one of: ${names.join(', ')}`);
}

function baseUrl(envName: string, fallback: string): string {
  return process.env[envName]?.trim().replace(/\/$/u, '') || fallback;
}

function egressContext(request?: Pick<VideoGenerationRequest, 'egress_tier' | 'tenant_slug'>) {
  return request?.egress_tier
    ? {
        tier: request.egress_tier,
        tenant_slug: request.tenant_slug,
        purpose: 'video generation prompt and artifact retrieval',
      }
    : undefined;
}

async function jsonRequest<T>(
  url: string,
  method: 'GET' | 'POST',
  options: {
    headers: Record<string, string>;
    data?: unknown;
    params?: Record<string, string | number>;
    request?: VideoGenerationRequest;
  }
): Promise<T> {
  return secureFetch<T>({
    url,
    method,
    headers: options.headers,
    data: options.data,
    params: options.params,
    authenticateRequest: true,
    kyberion_egress_context: egressContext(options.request),
  });
}

async function downloadUrl(
  url: string,
  request?: VideoGenerationRequest,
  headers?: Record<string, string>
): Promise<Buffer> {
  const data = await secureFetch<Buffer | ArrayBuffer>({
    url,
    method: 'GET',
    headers,
    responseType: 'arraybuffer',
    authenticateRequest: Boolean(headers?.Authorization),
    kyberion_egress_context: egressContext(request),
  });
  return Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
}

function statusFrom(value: unknown): VideoProviderStatus {
  const status = String(value || '').toLowerCase();
  if (/(complete|completed|success|succeeded|done)/u.test(status)) return 'succeeded';
  if (/(fail|error|cancel|abort)/u.test(status)) {
    return /(cancel|abort)/u.test(status) ? 'canceled' : 'failed';
  }
  if (/(process|running|render|queue|pending|prepar)/u.test(status)) return 'running';
  return 'submitted';
}

function outputUrl(value: JsonRecord): string | undefined {
  const candidates = [
    value.output_url,
    value.download_url,
    value.video_url,
    Array.isArray(value.output) ? value.output[0] : undefined,
    Array.isArray(value.videos) ? value.videos[0]?.url : undefined,
  ];
  return candidates.find(
    (candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0
  );
}

function runwayRatio(request: VideoGenerationRequest): string | undefined {
  if (request.resolution) return request.resolution;
  switch (request.aspect_ratio) {
    case '16:9':
      return '1280:720';
    case '9:16':
      return '720:1280';
    case '1:1':
      return '960:960';
    default:
      return request.aspect_ratio;
  }
}

function targetPath(request: VideoGenerationRequest, providerJobId: string): string {
  const configured = request.target_path?.trim();
  if (configured) return configured;
  return pathResolver.sharedTmp(`video-generation/${providerJobId}.mp4`);
}

function writeArtifact(
  request: VideoGenerationRequest,
  providerJobId: string,
  bytes: Buffer
): VideoGenerationArtifact {
  const destination = targetPath(request, providerJobId);
  safeMkdir(path.dirname(destination), { recursive: true });
  safeWriteFile(destination, bytes);
  return {
    kind: 'video',
    filename: path.basename(destination),
    type: 'output',
    path: destination,
  };
}

class GoogleVeoProvider implements VideoGenerationProvider {
  readonly provider = 'google_veo';
  private readonly requestByJob = new Map<string, VideoGenerationRequest>();

  private apiKey(): string {
    return requireEnv('KYBERION_GEMINI_VIDEO_API_KEY', 'GEMINI_API_KEY');
  }

  private baseUrl(): string {
    return baseUrl('KYBERION_GEMINI_VIDEO_URL', 'https://generativelanguage.googleapis.com/v1beta');
  }

  async submit(request: VideoGenerationRequest): Promise<VideoGenerationSubmission> {
    const key = this.apiKey();
    const instance: JsonRecord = { prompt: request.prompt };
    if (request.first_frame_image?.startsWith('data:')) {
      const match = request.first_frame_image.match(/^data:([^;]+);base64,(.+)$/u);
      if (match) instance.image = { inlineData: { mimeType: match[1], data: match[2] } };
    }
    if (request.last_frame_image?.startsWith('data:')) {
      const match = request.last_frame_image.match(/^data:([^;]+);base64,(.+)$/u);
      if (match) instance.lastFrame = { inlineData: { mimeType: match[1], data: match[2] } };
    }
    const parameters: JsonRecord = {};
    if (request.aspect_ratio) parameters.aspectRatio = request.aspect_ratio;
    if (request.resolution) parameters.resolution = request.resolution;
    const operation = await jsonRequest<JsonRecord>(
      `${this.baseUrl()}/models/${encodeURIComponent(request.model)}:predictLongRunning`,
      'POST',
      {
        headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
        data: { instances: [instance], ...(Object.keys(parameters).length ? { parameters } : {}) },
        request,
      }
    );
    const providerJobId = String(operation.name || asRecord(operation.operation).name || '');
    if (!providerJobId) throw new Error('Google Veo submission did not return an operation name');
    this.requestByJob.set(providerJobId, request);
    return { provider_job_id: providerJobId, status: 'submitted', provider: this.provider };
  }

  async status(
    providerJobId: string,
    request?: VideoGenerationRequest
  ): Promise<VideoGenerationStatus> {
    const requestContext = request || this.requestByJob.get(providerJobId);
    const key = this.apiKey();
    const url = providerJobId.startsWith('http')
      ? providerJobId
      : `${this.baseUrl()}/${providerJobId.replace(/^\//u, '')}`;
    const operation = await jsonRequest<JsonRecord>(url, 'GET', {
      headers: { 'x-goog-api-key': key },
      request: requestContext,
    });
    const response = asRecord(operation.response);
    const generatedVideoResponse = asRecord(response.generateVideoResponse);
    const generatedSamples = Array.isArray(generatedVideoResponse.generatedSamples)
      ? generatedVideoResponse.generatedSamples
      : [];
    const sample = asRecord(asRecord(generatedSamples[0]).video);
    const status: VideoGenerationStatus = {
      provider_job_id: providerJobId,
      provider: this.provider,
      status: operation.done === true ? (operation.error ? 'failed' : 'succeeded') : 'running',
      output_url: typeof sample.uri === 'string' ? sample.uri : undefined,
      inline_video_base64: typeof sample.videoBytes === 'string' ? sample.videoBytes : undefined,
      error: operation.error ? JSON.stringify(operation.error) : undefined,
    };
    return status;
  }

  async download(status: VideoGenerationStatus, request?: VideoGenerationRequest): Promise<Buffer> {
    if (status.inline_video_base64) return Buffer.from(status.inline_video_base64, 'base64');
    if (!status.output_url) throw new Error('Google Veo completed without a video URI');
    return downloadUrl(
      status.output_url,
      request || this.requestByJob.get(status.provider_job_id),
      {
        'x-goog-api-key': this.apiKey(),
      }
    );
  }
}

class RunwayProvider implements VideoGenerationProvider {
  readonly provider = 'runway';
  private readonly requestByJob = new Map<string, VideoGenerationRequest>();

  private key(): string {
    return requireEnv('KYBERION_RUNWAY_API_KEY', 'RUNWAYML_API_SECRET');
  }

  private baseUrl(): string {
    return baseUrl('KYBERION_RUNWAY_VIDEO_URL', 'https://api.dev.runwayml.com/v1');
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.key()}`,
      'X-Runway-Version': '2024-11-06',
      'Content-Type': 'application/json',
    };
  }

  async submit(request: VideoGenerationRequest): Promise<VideoGenerationSubmission> {
    const promptImage =
      request.first_frame_image && request.last_frame_image
        ? [
            { uri: request.first_frame_image, position: 'first' },
            { uri: request.last_frame_image, position: 'last' },
          ]
        : request.first_frame_image;
    const payload: JsonRecord = {
      model: request.model,
      promptText: request.prompt,
      ...(promptImage ? { promptImage } : {}),
      ...(runwayRatio(request) ? { ratio: runwayRatio(request) } : {}),
      ...(request.duration_seconds ? { duration: request.duration_seconds } : {}),
      ...(typeof request.generate_audio === 'boolean'
        ? { generateAudio: request.generate_audio }
        : {}),
    };
    const task = await jsonRequest<JsonRecord>(`${this.baseUrl()}/image_to_video`, 'POST', {
      headers: this.headers(),
      data: payload,
      request,
    });
    const providerJobId = String(task.id || task.task_id || '');
    if (!providerJobId) throw new Error('Runway submission did not return a task id');
    this.requestByJob.set(providerJobId, request);
    return { provider_job_id: providerJobId, status: 'submitted', provider: this.provider };
  }

  async status(
    providerJobId: string,
    request?: VideoGenerationRequest
  ): Promise<VideoGenerationStatus> {
    const task = await jsonRequest<JsonRecord>(
      `${this.baseUrl()}/tasks/${encodeURIComponent(providerJobId)}`,
      'GET',
      {
        headers: this.headers(),
        request: request || this.requestByJob.get(providerJobId),
      }
    );
    const status = statusFrom(task.status);
    return {
      provider_job_id: providerJobId,
      provider: this.provider,
      status,
      output_url: outputUrl(task),
      error: typeof task.failure === 'string' ? task.failure : undefined,
      metadata: { failure_code: task.failureCode },
    };
  }

  async download(status: VideoGenerationStatus, request?: VideoGenerationRequest): Promise<Buffer> {
    if (!status.output_url) throw new Error('Runway completed without an output URL');
    return downloadUrl(status.output_url, request || this.requestByJob.get(status.provider_job_id));
  }
}

class OpenAiSoraProvider implements VideoGenerationProvider {
  readonly provider = 'openai_sora';
  private readonly requestByJob = new Map<string, VideoGenerationRequest>();

  private key(): string {
    return requireEnv('KYBERION_OPENAI_VIDEO_API_KEY', 'OPENAI_API_KEY');
  }

  private baseUrl(): string {
    return baseUrl('KYBERION_OPENAI_VIDEO_URL', 'https://api.openai.com/v1');
  }

  async submit(request: VideoGenerationRequest): Promise<VideoGenerationSubmission> {
    const form = new FormData();
    form.append('model', request.model);
    form.append('prompt', request.prompt);
    if (request.duration_seconds) form.append('seconds', String(request.duration_seconds));
    if (request.resolution) form.append('size', request.resolution);
    if (request.first_frame_image?.startsWith('data:')) {
      const match = request.first_frame_image.match(/^data:([^;]+);base64,(.+)$/u);
      if (match) {
        form.append(
          'input_reference',
          new Blob([Buffer.from(match[2], 'base64')], { type: match[1] }),
          'reference-image'
        );
      }
    }
    const response = await secureFetch<JsonRecord>({
      url: `${this.baseUrl()}/videos`,
      method: 'POST',
      headers: { Authorization: `Bearer ${this.key()}` },
      data: form,
      authenticateRequest: true,
      kyberion_egress_context: egressContext(request),
    });
    const providerJobId = String(response.id || '');
    if (!providerJobId) throw new Error('OpenAI Sora submission did not return a video id');
    this.requestByJob.set(providerJobId, request);
    return {
      provider_job_id: providerJobId,
      status: statusFrom(response.status),
      provider: this.provider,
    };
  }

  async status(
    providerJobId: string,
    request?: VideoGenerationRequest
  ): Promise<VideoGenerationStatus> {
    const response = await jsonRequest<JsonRecord>(
      `${this.baseUrl()}/videos/${encodeURIComponent(providerJobId)}`,
      'GET',
      {
        headers: { Authorization: `Bearer ${this.key()}` },
        request: request || this.requestByJob.get(providerJobId),
      }
    );
    return {
      provider_job_id: providerJobId,
      provider: this.provider,
      status: statusFrom(response.status),
      error: typeof response.error === 'string' ? response.error : undefined,
      metadata: response,
    };
  }

  async download(status: VideoGenerationStatus, request?: VideoGenerationRequest): Promise<Buffer> {
    return downloadUrl(
      `${this.baseUrl()}/videos/${encodeURIComponent(status.provider_job_id)}/content`,
      request || this.requestByJob.get(status.provider_job_id),
      {
        Authorization: `Bearer ${this.key()}`,
      }
    );
  }
}

class MiniMaxHailuoProvider implements VideoGenerationProvider {
  readonly provider = 'minimax_hailuo';
  private readonly requestByJob = new Map<string, VideoGenerationRequest>();
  private readonly fileByJob = new Map<string, string>();

  private key(): string {
    return requireEnv('KYBERION_MINIMAX_VIDEO_API_KEY', 'MINIMAX_API_KEY');
  }

  private baseUrl(): string {
    return baseUrl('KYBERION_MINIMAX_VIDEO_URL', 'https://api.minimaxi.com/v1');
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.key()}`, 'Content-Type': 'application/json' };
  }

  async submit(request: VideoGenerationRequest): Promise<VideoGenerationSubmission> {
    const payload: JsonRecord = {
      model: request.model,
      prompt: request.prompt,
      ...(request.duration_seconds ? { duration: request.duration_seconds } : {}),
      ...(request.resolution ? { resolution: request.resolution } : {}),
      ...(request.first_frame_image ? { first_frame_image: request.first_frame_image } : {}),
      ...(request.last_frame_image ? { last_frame_image: request.last_frame_image } : {}),
    };
    const response = await jsonRequest<JsonRecord>(`${this.baseUrl()}/video_generation`, 'POST', {
      headers: this.headers(),
      data: payload,
      request,
    });
    const providerJobId = String(response.task_id || '');
    if (!providerJobId) throw new Error('MiniMax submission did not return a task id');
    this.requestByJob.set(providerJobId, request);
    return { provider_job_id: providerJobId, status: 'submitted', provider: this.provider };
  }

  async status(
    providerJobId: string,
    request?: VideoGenerationRequest
  ): Promise<VideoGenerationStatus> {
    const response = await jsonRequest<JsonRecord>(
      `${this.baseUrl()}/query/video_generation`,
      'GET',
      {
        headers: this.headers(),
        params: { task_id: providerJobId },
        request: request || this.requestByJob.get(providerJobId),
      }
    );
    const fileId = typeof response.file_id === 'string' ? response.file_id : undefined;
    if (fileId) this.fileByJob.set(providerJobId, fileId);
    return {
      provider_job_id: providerJobId,
      provider: this.provider,
      status: statusFrom(response.status),
      file_id: fileId,
      error:
        response.status === 'Fail' ? JSON.stringify(response.base_resp || response) : undefined,
      metadata: { video_width: response.video_width, video_height: response.video_height },
    };
  }

  async download(status: VideoGenerationStatus, request?: VideoGenerationRequest): Promise<Buffer> {
    const fileId = status.file_id || this.fileByJob.get(status.provider_job_id);
    if (!fileId) throw new Error('MiniMax completed without a file id');
    const response = await jsonRequest<JsonRecord>(`${this.baseUrl()}/files/retrieve`, 'GET', {
      headers: this.headers(),
      params: { file_id: fileId },
      request: request || this.requestByJob.get(status.provider_job_id),
    });
    const url = outputUrl(asRecord(response.file));
    if (!url) throw new Error('MiniMax file retrieval did not return a download URL');
    return downloadUrl(url, this.requestByJob.get(status.provider_job_id));
  }
}

const PROVIDER_FACTORIES: Record<string, () => VideoGenerationProvider> = {
  google_veo: () => new GoogleVeoProvider(),
  runway: () => new RunwayProvider(),
  openai_sora: () => new OpenAiSoraProvider(),
  minimax_hailuo: () => new MiniMaxHailuoProvider(),
};

export function isDirectVideoGenerationBackend(backend: MediaBackendRecord): boolean {
  return (
    backend.modality === 'video' && backend.kind === 'api' && backend.provider in PROVIDER_FACTORIES
  );
}

export function resolveVideoGenerationBackend(params: VideoGenerationParams): MediaBackendRecord {
  const backendId = String(params.backend_id || params.video_adf?.engine?.backend_id || '').trim();
  return getMediaBackendRecord(backendId || undefined, 'video');
}

export function createVideoGenerationProvider(
  backend: MediaBackendRecord
): VideoGenerationProvider {
  const factory = PROVIDER_FACTORIES[backend.provider];
  if (!factory)
    throw new Error(`No video generation provider adapter registered for ${backend.provider}`);
  return factory();
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
    };
  }
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
  };
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
    return { ...status, backend_id: backend.backend_id, backend_provider: backend.provider };
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
