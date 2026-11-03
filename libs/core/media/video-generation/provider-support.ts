import { getRegisteredEnvText } from '../../foundation/env.js';
import { secureFetch } from '../../network.js';
import { pathResolver } from '../../path-resolver.js';
import { assertSafeRepositoryPath, safeMkdir, safeWriteFile } from '../../secure-io.js';
import * as path from 'node:path';
import type {
  VideoGenerationJsonRecord,
  VideoGenerationArtifact,
  VideoGenerationRequest,
  VideoProviderStatus,
} from './types.js';

export function asRecord(value: unknown): VideoGenerationJsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as VideoGenerationJsonRecord)
    : {};
}

export function isJsonRecord(value: unknown): value is VideoGenerationJsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function requireEnv(...names: string[]): string {
  for (const name of names) {
    const value = getRegisteredEnvText(name)?.trim();
    if (value) return value;
  }
  throw new Error(`Video provider credential is missing. Set one of: ${names.join(', ')}`);
}

export function baseUrl(envName: string, fallback: string): string {
  return getRegisteredEnvText(envName)?.trim().replace(/\/$/u, '') || fallback;
}

export function egressContext(
  request?: Pick<VideoGenerationRequest, 'egress_tier' | 'tenant_slug'>
) {
  return request?.egress_tier
    ? {
        tier: request.egress_tier,
        tenant_slug: request.tenant_slug,
        purpose: 'video generation prompt and artifact retrieval',
      }
    : undefined;
}

export async function jsonRequest(
  url: string,
  method: 'GET' | 'POST',
  options: {
    headers: Record<string, string>;
    data?: unknown;
    params?: Record<string, string | number>;
    request?: VideoGenerationRequest;
  }
): Promise<VideoGenerationJsonRecord> {
  const response: unknown = await secureFetch({
    url,
    method,
    headers: options.headers,
    data: options.data,
    params: options.params,
    authenticateRequest: true,
    kyberion_egress_context: egressContext(options.request),
  });
  if (!isJsonRecord(response)) {
    throw new Error(`Video provider response must be a JSON object: ${url}`);
  }
  return response;
}

export async function downloadUrl(
  url: string,
  request?: VideoGenerationRequest,
  headers?: Record<string, string>
): Promise<Buffer> {
  const data: unknown = await secureFetch({
    url,
    method: 'GET',
    headers,
    responseType: 'arraybuffer',
    authenticateRequest: Boolean(headers?.Authorization),
    kyberion_egress_context: egressContext(request),
  });
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  throw new Error('Video provider download response must be binary data');
}
export function statusFrom(value: unknown): VideoProviderStatus {
  const status = String(value || '').toLowerCase();
  if (/(complete|completed|success|succeeded|done)/u.test(status)) return 'succeeded';
  if (/(fail|error|cancel|abort)/u.test(status)) {
    return /(cancel|abort)/u.test(status) ? 'canceled' : 'failed';
  }
  if (/(process|running|render|queue|pending|prepar)/u.test(status)) return 'running';
  return 'submitted';
}

export function outputUrl(value: VideoGenerationJsonRecord): string | undefined {
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

export function runwayRatio(request: VideoGenerationRequest): string | undefined {
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

export function targetPath(request: VideoGenerationRequest, providerJobId: string): string {
  const configured = request.target_path?.trim();
  if (configured) {
    return assertSafeRepositoryPath(pathResolver.rootResolve(configured), {
      allowMissingLeaf: true,
    });
  }
  return pathResolver.sharedTmp(`video-generation/${providerJobId}.mp4`);
}

export function writeArtifact(
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
