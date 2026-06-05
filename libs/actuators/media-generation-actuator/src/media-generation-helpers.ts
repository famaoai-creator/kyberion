import {
  safeReadFile,
  safeWriteFile,
  safeCopyFileSync,
  safeExistsSync,
  safeMkdir,
  pathResolver,
  classifyError,
  secureFetch,
  withRetry,
  compileMusicGenerationADF,
  compileImageGenerationADF,
  compileVideoGenerationADF,
  resolveImageBackend,
} from '@agent/core';
import * as path from 'node:path';

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

const DEFAULT_COMFY_BASE_URL = process.env.KYBERION_COMFY_BASE_URL || 'http://127.0.0.1:8188';
const DEFAULT_COMFY_OUTPUT_DIR = process.env.KYBERION_COMFY_OUTPUT_DIR || '/Users/famaoai/Documents/comfy/ComfyUI/output';
const GENERATION_JOB_DIR = 'active/shared/runtime/media-generation/jobs';
const TERMINAL_JOB_STATUSES = new Set(['succeeded', 'failed', 'timed_out', 'canceled']);
const MEDIA_GENERATION_MANIFEST_PATH = pathResolver.rootResolve('libs/actuators/media-generation-actuator/manifest.json');
const DEFAULT_MEDIA_RETRY = {
  maxRetries: 2,
  initialDelayMs: 500,
  maxDelayMs: 10000,
  factor: 2,
  jitter: true,
};

let cachedRecoveryPolicy: Record<string, any> | undefined;

function resolveGenerationBackend(action: string, params: any) {
  const backendId = String(
    params?.backend_id
    || params?.image_adf?.engine?.backend_id
    || params?.video_adf?.engine?.backend_id
    || params?.music_adf?.engine?.backend_id
    || 'media-generation.comfyui',
  ).trim() || 'media-generation.comfyui';
  void action;
  return resolveImageBackend(backendId, process.platform);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIso(): string {
  return new Date().toISOString();
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function loadRecoveryPolicy(): Record<string, any> {
  if (cachedRecoveryPolicy) return cachedRecoveryPolicy;
  try {
    const manifest = JSON.parse(safeReadFile(MEDIA_GENERATION_MANIFEST_PATH, { encoding: 'utf8' }) as string);
    cachedRecoveryPolicy = isPlainObject(manifest?.recovery_policy) ? manifest.recovery_policy : {};
    return cachedRecoveryPolicy ?? {};
  } catch (_) {
    cachedRecoveryPolicy = {};
    return cachedRecoveryPolicy ?? {};
  }
}

function buildRetryOptions(override?: Record<string, any>) {
  const manifestRetry = isPlainObject(loadRecoveryPolicy().retry) ? loadRecoveryPolicy().retry : {};
  const retryableCategories = new Set<string>(
    Array.isArray(loadRecoveryPolicy().retryable_categories) ? loadRecoveryPolicy().retryable_categories.map(String) : [],
  );
  const resolved = {
    ...DEFAULT_MEDIA_RETRY,
    ...manifestRetry,
    ...(override || {}),
  };
  return {
    ...resolved,
    shouldRetry: (error: Error) => {
      const classification = classifyError(error);
      if (retryableCategories.size > 0) {
        return retryableCategories.has(classification.category);
      }
      return classification.category === 'network'
        || classification.category === 'rate_limit'
        || classification.category === 'timeout'
        || classification.category === 'resource_unavailable';
    },
  };
}

function ensureGenerationJobDir(): void {
  if (!safeExistsSync(GENERATION_JOB_DIR)) {
    safeMkdir(GENERATION_JOB_DIR, { recursive: true });
  }
}

function createGenerationJobId(action: string): string {
  return `genjob-${action}-${Date.now()}`;
}

function generationJobPath(jobId: string): string {
  return path.join(GENERATION_JOB_DIR, `${jobId}.json`);
}

function writeJob(job: any): any {
  ensureGenerationJobDir();
  safeWriteFile(generationJobPath(job.job_id), JSON.stringify(job, null, 2));
  return job;
}

function readJob(jobId: string): any {
  return JSON.parse(safeReadFile(generationJobPath(jobId), { encoding: 'utf8' }) as string);
}

function resolveArtifactPath(item: Record<string, any>): string {
  const typeDir = item.type && item.type !== 'output' ? String(item.type) : '';
  const subfolder = item.subfolder ? String(item.subfolder) : '';
  return path.join(DEFAULT_COMFY_OUTPUT_DIR, typeDir, subfolder, String(item.filename));
}

function extractArtifacts(history: any): GeneratedArtifact[] {
  const outputs = history?.outputs;
  if (!outputs || typeof outputs !== 'object') return [];

  const artifacts: GeneratedArtifact[] = [];
  for (const nodeOutput of Object.values(outputs) as any[]) {
    if (!nodeOutput || typeof nodeOutput !== 'object') continue;
    for (const [kind, value] of Object.entries(nodeOutput)) {
      if (!Array.isArray(value)) continue;
      for (const item of value) {
        if (!item?.filename) continue;
        artifacts.push({
          kind,
          filename: String(item.filename),
          type: String(item.type || 'output'),
          subfolder: item.subfolder ? String(item.subfolder) : undefined,
          path: resolveArtifactPath(item),
        });
      }
    }
  }
  return artifacts;
}

function isTerminalStatus(status?: string): boolean {
  return status ? TERMINAL_JOB_STATUSES.has(status) : false;
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
    params?.backend_id
    || params?.image_adf?.engine?.backend_id
    || '',
  ).trim();
  if (explicitBackendId) {
    const backendTokens = explicitBackendId.split('.').filter(Boolean);
    const tail = backendTokens[backendTokens.length - 1] || explicitBackendId;
    if (tail === 'local_flux' || explicitBackendId === 'local_flux') return ['local_flux'];
    if (tail === 'comfyui' || explicitBackendId === 'media-generation.comfyui') return ['comfyui'];
    if (tail === 'llm_api') return ['llm_api'];
  }

  const preference = params?.provider_preference || params?.providerPreference;
  return Array.isArray(preference) && preference.length > 0 ? preference : undefined;
}

function preparePromptBasedGeneration(action: string, params: any): PromptGenerationRequest {
  const compiled =
    action === 'generate_music' && params.music_adf ? compileMusicGenerationADF(params.music_adf) :
    action === 'generate_image' && params.image_adf ? compileImageGenerationADF(params.image_adf) :
    action === 'generate_video' && params.video_adf ? compileVideoGenerationADF(params.video_adf) :
    null;
  const workflow = params.workflow || compiled?.workflow;
  const hasWorkflowPath = Boolean(params.workflow_path);
  if (!workflow && !hasWorkflowPath) {
    const message = action === 'generate_music'
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

async function waitForPromptCompletion(promptId: string, timeoutMs: number, pollIntervalMs: number): Promise<any> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const history = await withRetry(async () => {
      return await secureFetch({
        method: 'GET',
        url: `${DEFAULT_COMFY_BASE_URL}/history/${promptId}`,
      });
    }, buildRetryOptions());
    if (history && Object.keys(history).length > 0) {
      const promptHistory = history[promptId];
      if (promptHistory?.status?.completed || promptHistory?.outputs) {
        return promptHistory;
      }
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(`Timed out waiting for Comfy prompt ${promptId}`);
}

async function collectGenerationResult(action: string, params: any, promptId: string, compiled?: any) {
  const timeoutMs = Number(params.timeout_ms || params.music_adf?.output?.timeout_ms || 15 * 60 * 1000);
  const pollIntervalMs = Number(params.poll_interval_ms || params.music_adf?.output?.poll_interval_ms || 5_000);
  const history = await waitForPromptCompletion(promptId, timeoutMs, pollIntervalMs);
  const artifacts = extractArtifacts(history);
  const primaryArtifact = artifacts[0];
  const backend = resolveGenerationBackend(action, params);
  const requestedOutputPath = params.output_path || params.path;
  const copiedPath = primaryArtifact ? maybeCopyArtifact(primaryArtifact.path, requestedOutputPath) : undefined;
  return {
    action,
    prompt_id: promptId,
    status: primaryArtifact ? 'succeeded' : 'failed',
    artifacts,
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
  waitForPromptCompletion,
  collectGenerationResult,
};
