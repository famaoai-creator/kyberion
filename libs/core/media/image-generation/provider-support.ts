import { isRecord } from '../../foundation/text.js';
import { pathResolver } from '../../path-resolver.js';
import { assertSafeRepositoryPath } from '../../secure-io.js';
import { parseSafeJsonObjectValue } from '../../foundation/safe-json.js';
import { ImageGenerationRequest } from '../image-generation-types.js';

export function getFallbackTargetPath(request: ImageGenerationRequest): string {
  const filename = `generated-${Date.now()}-${Math.random().toString(36).substring(2, 7)}.jpg`;
  const candidate = request.targetPath || pathResolver.resolve(`active/shared/tmp/${filename}`);
  assertSafeRepositoryPath(pathResolver.resolve(candidate), { allowMissingLeaf: true });
  return candidate;
}

export function isRateLimitOrQuotaError(error: unknown): boolean {
  if (!error) return false;
  const msg = error instanceof Error ? error.message : String(error);
  return /429|resource_exhausted|rate\s*limit|quota/i.test(msg);
}

export function imageBytesFromResponse(value: unknown): string | undefined {
  if (typeof value === 'string') return normalizeImageBytes(value);
  if (!isRecord(value)) return undefined;
  let safeValue: Record<string, unknown>;
  try {
    safeValue = parseSafeJsonObjectValue(value, 'image generation response');
  } catch {
    return undefined;
  }
  const direct = normalizeImageBytes(safeValue.imageBytes);
  if (direct) return direct;
  if (Array.isArray(safeValue.generatedImages)) {
    const first = safeValue.generatedImages[0];
    if (isRecord(first) && isRecord(first.image)) {
      const nested = normalizeImageBytes(first.image.imageBytes);
      if (nested) return nested;
    }
  }
  if (isRecord(safeValue.result)) return normalizeImageBytes(safeValue.result.imageBytes);
  return undefined;
}

export function normalizeImageBytes(candidate: unknown): string | undefined {
  if (typeof candidate !== 'string') return undefined;
  const normalized = candidate.trim();
  if (!normalized || normalized.length % 4 === 1 || !/^[A-Za-z0-9+/]+=*$/u.test(normalized)) {
    return undefined;
  }
  const decoded = Buffer.from(normalized, 'base64');
  if (decoded.length === 0) return undefined;
  const withoutPadding = normalized.replace(/=+$/u, '');
  if (decoded.toString('base64').replace(/=+$/u, '') !== withoutPadding) return undefined;
  return normalized;
}

export function dallEImageBytesFromResponse(value: unknown): string | undefined {
  try {
    const safeValue = parseSafeJsonObjectValue(value, 'OpenAI DALL-E response');
    if (!Array.isArray(safeValue.data) || !isRecord(safeValue.data[0])) return undefined;
    return normalizeImageBytes(safeValue.data[0].b64_json);
  } catch {
    return undefined;
  }
}
