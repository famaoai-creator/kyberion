import {
  safeReadFile,
  safeWriteFile,
  safeCopyFileSync,
  safeExistsSync,
  safeMkdir,
  executeServicePreset,
  pathResolver,
  buildGovernedRetryOptions,
  loadRecoveryPolicy as loadCoreRecoveryPolicy,
  secureFetch,
  retry,
  compileMusicGenerationADF,
  compileImageGenerationADF,
  compileVideoGenerationADF,
  resolveMediaBackendForPlatform,
  sleep,
  resolveCreativeDesign,
  renderPromptStyleBlock,
} from '@agent/core';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { GenerationJob } from '@agent/core';
import {
  getGenerationHistoryAdapter,
  getGenerationHistoryAdapterForAction,
  modalityForGenerationAction,
  type ProviderHistory,
} from './generation-artifact-adapters.js';

export type GeneratedArtifact = {
  kind: string;
  filename: string;
  type: string;
  subfolder?: string;
  path: string;
};

export type PromptGenerationRequest = {
  action: string;
  params: any;
  compiled?: any;
  workflow?: any;
};

export type GenerationModality = 'image' | 'video' | 'music' | 'workflow';

export type GenerationBackend = {
  backend_id: string;
  modality: GenerationModality;
  kind: string;
  provider: string;
  status?: string;
  supports?: { artifact_formats?: string[]; async?: boolean };
};

const DEFAULT_COMFY_BASE_URL = process.env.KYBERION_COMFY_BASE_URL || 'http://127.0.0.1:8188';
// External, operator-configured ComfyUI output dir; KYBERION_COMFY_OUTPUT_DIR overrides this default.
const DEFAULT_COMFY_OUTPUT_DIR =
  process.env.KYBERION_COMFY_OUTPUT_DIR || pathResolver.sharedTmp('comfy/output');
const GENERATION_JOB_DIR = 'active/shared/runtime/media-generation/jobs';
const MEDIA_GENERATION_MANIFEST_PATH = pathResolver.rootResolve(
  'libs/actuators/media-generation-actuator/manifest.json'
);
const DEFAULT_MEDIA_RETRY = {
  maxRetries: 2,
  initialDelayMs: 500,
  maxDelayMs: 10000,
  factor: 2,
  jitter: true,
};

function resolveGenerationBackend(
  action: string,
  params: Record<string, unknown>
): GenerationBackend {
  const adfBackendId = ['image_adf', 'video_adf', 'music_adf']
    .map((key) => {
      const candidate = params[key];
      const adf = isPlainObject(candidate) ? candidate : undefined;
      const engine = adf && isPlainObject(adf.engine) ? adf.engine : undefined;
      return engine && typeof engine.backend_id === 'string' ? engine.backend_id : undefined;
    })
    .find((value): value is string => Boolean(value));
  const backendId =
    (typeof params.backend_id === 'string' ? params.backend_id : adfBackendId || '').trim() ||
    'media-generation.comfyui';
  const modality: GenerationModality =
    action === 'generate_image'
      ? 'image'
      : action === 'generate_video'
        ? 'video'
        : action === 'generate_music'
          ? 'music'
          : 'workflow';
  if (modality === 'image' || modality === 'video' || modality === 'music') {
    const backend = resolveMediaBackendForPlatform(modality, backendId, process.platform);
    return { ...backend, modality };
  }

  return {
    backend_id: backendId,
    modality,
    kind: 'service_preset',
    provider: 'comfyui',
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function loadRecoveryPolicy(): Record<string, any> {
  return loadCoreRecoveryPolicy(MEDIA_GENERATION_MANIFEST_PATH);
}

function buildRetryOptions(override?: Record<string, any>) {
  return buildGovernedRetryOptions({
    manifestPath: MEDIA_GENERATION_MANIFEST_PATH,
    defaults: DEFAULT_MEDIA_RETRY,
    override: override,
    fallbackCategories: ['network', 'rate_limit', 'timeout', 'resource_unavailable'],
  });
}

function ensureGenerationJobDir(): void {
  if (!safeExistsSync(GENERATION_JOB_DIR)) {
    safeMkdir(GENERATION_JOB_DIR, { recursive: true });
  }
}

function createGenerationJobId(action: string): string {
  return `genjob-${action}-${randomUUID()}`;
}

function generationJobPath(jobId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(jobId)) {
    throw new Error('Invalid generation job_id');
  }
  return path.join(GENERATION_JOB_DIR, `${jobId}.json`);
}

function isGenerationJob(value: unknown): value is GenerationJob {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const actions = new Set(['generate_image', 'generate_video', 'generate_music', 'run_workflow']);
  const statuses = new Set([
    'submitted',
    'running',
    'retrying',
    'succeeded',
    'failed',
    'timed_out',
    'canceled',
  ]);
  return (
    record.kind === 'generation-job' &&
    typeof record.job_id === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(record.job_id) &&
    typeof record.action === 'string' &&
    actions.has(record.action) &&
    typeof record.status === 'string' &&
    statuses.has(record.status) &&
    typeof record.request === 'object' &&
    record.request !== null &&
    typeof record.created_at === 'string' &&
    (!record.provider || (typeof record.provider === 'object' && record.provider !== null))
  );
}

function writeJob(job: GenerationJob): GenerationJob {
  if (!isGenerationJob(job)) {
    throw new Error('generation job schema mismatch');
  }
  ensureGenerationJobDir();
  safeWriteFile(generationJobPath(job.job_id), JSON.stringify(job, null, 2));
  return job;
}

function readJob(jobId: string): GenerationJob {
  const jobPath = generationJobPath(jobId);
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(safeReadFile(jobPath, { encoding: 'utf8' })));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`generation job JSON parse failed: ${message}`);
  }
  if (!isGenerationJob(parsed)) {
    throw new Error(`generation job schema mismatch: ${jobId}`);
  }
  return parsed;
}

function resolveArtifactPath(item: Record<string, any>): string {
  const filename = String(item.filename || '');
  const subfolder = item.subfolder ? String(item.subfolder) : '';
  const type = item.type ? String(item.type) : 'output';
  for (const value of [filename, type]) {
    if (
      !value ||
      path.isAbsolute(value) ||
      /[\u0000-\u001f]/u.test(value) ||
      value.split(/[\\/]+/u).some((segment) => segment === '..')
    ) {
      throw new Error('Invalid provider artifact path');
    }
  }
  if (
    /[\u0000-\u001f]/u.test(subfolder) ||
    path.isAbsolute(subfolder) ||
    subfolder.split(/[\\/]+/u).some((segment) => segment === '..')
  ) {
    throw new Error('Invalid provider artifact path');
  }
  const typeDir = item.type && item.type !== 'output' ? String(item.type) : '';
  const outputRoot = path.resolve(DEFAULT_COMFY_OUTPUT_DIR);
  const candidate = path.resolve(outputRoot, typeDir, subfolder, filename);
  const relative = path.relative(outputRoot, candidate);
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Provider artifact path escapes output root');
  }
  return candidate;
}

function extractArtifacts(
  history: unknown,
  modality: GenerationModality = 'workflow'
): GeneratedArtifact[] {
  return getGenerationHistoryAdapter(modality).extract_artifacts(history, (item) =>
    resolveArtifactPath(item)
  );
}

function isTerminalStatus(status?: string): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'canceled';
}

function maybeCopyArtifact(sourcePath: string, targetPath?: string): string | undefined {
  if (!targetPath) return undefined;
  if (!safeExistsSync(sourcePath)) {
    throw new Error(`Generated artifact not found: ${sourcePath}`);
  }
  safeMkdir(path.dirname(targetPath), { recursive: true });
  safeCopyFileSync(sourcePath, targetPath);
  return targetPath;
}

function resolveImageArtifactFormat(sourcePath: string): string {
  const ext = path.extname(sourcePath).toLowerCase().replace(/^\./, '');
  return ext || 'jpg';
}

function resolveImageProviderPreference(params: any): string[] | undefined {
  const explicitBackendId = String(
    params?.backend_id || params?.image_adf?.engine?.backend_id || ''
  ).trim();
  if (explicitBackendId) {
    const backendTokens = explicitBackendId.split('.').filter(Boolean);
    const tail = backendTokens[backendTokens.length - 1] || explicitBackendId;
    if (tail === 'local_flux' || explicitBackendId === 'local_flux') return ['local_flux'];
    if (tail === 'apple_playground' || explicitBackendId === 'apple_playground') {
      return ['apple_playground', 'local_flux', 'comfyui'];
    }
    if (tail === 'comfyui' || explicitBackendId === 'media-generation.comfyui') return ['comfyui'];
    if (tail === 'llm_api') return ['llm_api'];
  }

  const preference = params?.provider_preference || params?.providerPreference;
  return Array.isArray(preference) && preference.length > 0 ? preference : undefined;
}

/**
 * E2E-02 Task 4: inject the brand/tenant style pack into generation prompts so
 * image / video / music output stays on-palette. Deterministic (vocabulary +
 * resolver only), opt-out via params.no_style_pack.
 */
function applyPromptStylePack(action: string, params: any): any {
  if (!params || params.no_style_pack === true) return params;
  const resolved = resolveCreativeDesign({
    surface: 'prompt',
    tenantSlug: typeof params.tenant_slug === 'string' ? params.tenant_slug : undefined,
  });
  if (resolved.projection.surface !== 'prompt') return params;
  const block = renderPromptStyleBlock(resolved.projection.style_pack, {
    music: action === 'generate_music',
  });
  const appendTo = (prompt: unknown): unknown =>
    typeof prompt === 'string' && prompt.trim().length > 0 && !prompt.includes('Style: palette=')
      ? `${prompt}\n\n${block}`
      : prompt;

  const next = { ...params };
  if (typeof next.prompt === 'string') next.prompt = appendTo(next.prompt);
  for (const key of ['image_adf', 'video_adf', 'music_adf'] as const) {
    const adf = next[key];
    if (adf && typeof adf === 'object' && typeof adf.prompt === 'string') {
      next[key] = { ...adf, prompt: appendTo(adf.prompt) };
    }
  }
  return next;
}

function preparePromptBasedGeneration(action: string, input: any): PromptGenerationRequest {
  const params = applyPromptStylePack(action, input);
  const compiled =
    action === 'generate_music' && params.music_adf
      ? compileMusicGenerationADF(params.music_adf)
      : action === 'generate_image' && params.image_adf
        ? compileImageGenerationADF(params.image_adf)
        : action === 'generate_video' && params.video_adf
          ? compileVideoGenerationADF(params.video_adf)
          : null;
  const workflow = params.workflow || compiled?.workflow;
  const hasWorkflowPath = Boolean(params.workflow_path);
  const directImage =
    action === 'generate_image' && !workflow && !hasWorkflowPath && !params.image_adf;
  if (!workflow && !hasWorkflowPath && !directImage) {
    const message =
      action === 'generate_music'
        ? 'generate_music requires either params.workflow or params.music_adf'
        : action === 'generate_image'
          ? 'generate_image requires params.workflow, params.workflow_path, or params.image_adf'
          : action === 'generate_video'
            ? 'generate_video requires params.workflow, params.workflow_path, or params.video_adf'
            : `${action} requires params.workflow or params.workflow_path`;
    throw new Error(message);
  }
  return { action, params, compiled, workflow };
}

function resolveAwaitCompletion(action: string, params: Record<string, unknown>): boolean {
  if (typeof params.await_completion === 'boolean') return params.await_completion;
  const adfKey =
    action === 'generate_image'
      ? 'image_adf'
      : action === 'generate_video'
        ? 'video_adf'
        : action === 'generate_music'
          ? 'music_adf'
          : '';
  const adf = adfKey && isPlainObject(params[adfKey]) ? params[adfKey] : undefined;
  const output = adf && isPlainObject(adf.output) ? adf.output : undefined;
  if (output && typeof output.await_completion === 'boolean') {
    return output.await_completion;
  }
  return action === 'generate_music' && Boolean(adf);
}

async function waitForPromptCompletion(
  promptId: string,
  timeoutMs: number,
  pollIntervalMs: number,
  modality: GenerationModality = 'workflow'
): Promise<ProviderHistory> {
  const adapter = getGenerationHistoryAdapter(modality);
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const history = (await retry(async () => {
      return await secureFetch({
        method: 'GET',
        url: `${DEFAULT_COMFY_BASE_URL}/history/${promptId}`,
      });
    }, buildRetryOptions())) as unknown;
    if (history && typeof history === 'object' && !Array.isArray(history)) {
      const promptHistory = (history as Record<string, unknown>)[promptId];
      if (adapter.is_failed(promptHistory)) {
        throw new Error(`provider job ${promptId} failed or was canceled`);
      }
      if (adapter.is_complete(promptHistory)) {
        return (promptHistory || {}) as ProviderHistory;
      }
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(`Timed out waiting for Comfy prompt ${promptId}`);
}

function selectPrimaryArtifact(
  action: string,
  params: Record<string, unknown>,
  artifacts: GeneratedArtifact[]
): GeneratedArtifact | undefined {
  const adfKey =
    action === 'generate_image'
      ? 'image_adf'
      : action === 'generate_video'
        ? 'video_adf'
        : action === 'generate_music'
          ? 'music_adf'
          : '';
  const adf = adfKey && isPlainObject(params[adfKey]) ? params[adfKey] : undefined;
  const output = adf && isPlainObject(adf.output) ? adf.output : undefined;
  const requestedFormat =
    typeof params.format === 'string'
      ? params.format
      : output && typeof output.format === 'string'
        ? output.format
        : undefined;
  const allowedFormats: Record<string, readonly string[]> = {
    generate_image: ['png', 'jpg', 'jpeg', 'webp'],
    generate_video: ['mp4', 'mov', 'webm', 'gif'],
    generate_music: ['mp3', 'wav', 'flac'],
  };
  const modalityFormats = allowedFormats[action];
  const available = artifacts.filter(
    (artifact) =>
      safeExistsSync(artifact.path) &&
      (!modalityFormats ||
        modalityFormats.some((format) => artifact.filename.toLowerCase().endsWith(`.${format}`)))
  );
  const byFormat = requestedFormat
    ? available.filter((artifact) =>
        artifact.filename.toLowerCase().endsWith(`.${requestedFormat}`)
      )
    : available;
  const candidates = byFormat.length > 0 ? byFormat : available;
  return (
    candidates.find((artifact) => artifact.type === 'output') ||
    candidates.find((artifact) => artifact.kind !== 'preview' && artifact.kind !== 'temp') ||
    candidates[0]
  );
}

async function collectGenerationResult(
  action: string,
  params: any,
  promptId: string,
  compiled?: any
) {
  const timeoutMs = Number(
    params.timeout_ms || params.music_adf?.output?.timeout_ms || 15 * 60 * 1000
  );
  const pollIntervalMs = Number(
    params.poll_interval_ms || params.music_adf?.output?.poll_interval_ms || 5_000
  );
  const modality = modalityForGenerationAction(action);
  const adapter = getGenerationHistoryAdapterForAction(action);
  const history = await waitForPromptCompletion(promptId, timeoutMs, pollIntervalMs, modality);
  const artifacts = extractArtifacts(history, modality);
  const adfKey =
    action === 'generate_image'
      ? 'image_adf'
      : action === 'generate_video'
        ? 'video_adf'
        : action === 'generate_music'
          ? 'music_adf'
          : '';
  const adf = adfKey && isPlainObject(params[adfKey]) ? params[adfKey] : undefined;
  const output = adf && isPlainObject(adf.output) ? adf.output : undefined;
  const requestedFormat =
    typeof params.format === 'string'
      ? params.format
      : output && typeof output.format === 'string'
        ? output.format
        : undefined;
  const primaryArtifact = adapter.select_primary(artifacts, requestedFormat);
  const backend = resolveGenerationBackend(action, params);
  const requestedOutputPath =
    params.output_path ||
    params.target_path ||
    params.path ||
    params.music_adf?.output?.target_path ||
    params.image_adf?.output?.target_path ||
    params.video_adf?.output?.target_path;
  const copiedPath = primaryArtifact
    ? maybeCopyArtifact(primaryArtifact.path, requestedOutputPath)
    : undefined;
  return {
    action,
    prompt_id: promptId,
    status: primaryArtifact ? 'succeeded' : 'failed',
    artifacts: artifacts.filter((artifact) => safeExistsSync(artifact.path)),
    artifact: primaryArtifact || null,
    output_path: copiedPath || primaryArtifact?.path || requestedOutputPath,
    copied_to: copiedPath,
    compiled_generation_request: compiled?.resolved,
    backend_id: backend.backend_id,
    backend_kind: backend.kind,
    backend_provider: backend.provider,
    finished_at: nowIso(),
  };
}

async function executePreparedGeneration(
  action: string,
  prepared: PromptGenerationRequest
): Promise<Record<string, unknown>> {
  const result = await executeServicePreset('media-generation', action, {
    ...prepared.params,
    workflow: prepared.workflow,
  });
  return isPlainObject(result) ? result : { status: 'failed', message: 'invalid backend result' };
}

export {
  resolveGenerationBackend,
  sleep,
  nowIso,
  isPlainObject,
  loadRecoveryPolicy,
  buildRetryOptions,
  ensureGenerationJobDir,
  createGenerationJobId,
  generationJobPath,
  writeJob,
  readJob,
  resolveArtifactPath,
  extractArtifacts,
  isTerminalStatus,
  maybeCopyArtifact,
  resolveImageArtifactFormat,
  resolveImageProviderPreference,
  preparePromptBasedGeneration,
  resolveAwaitCompletion,
  executePreparedGeneration,
  waitForPromptCompletion,
  collectGenerationResult,
  getGenerationHistoryAdapter,
  getGenerationHistoryAdapterForAction,
};
