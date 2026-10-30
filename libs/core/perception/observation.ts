import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathResolver } from '../path-resolver.js';
import { assertSafeRepositoryPath, safeReadFileRange, safeLstat } from '../secure-io.js';
import { resolveScopeContext } from '../scope-context.js';
import { inferImagePayloadTier } from '../media/image-description-bridge.js';
import { classifyStorageFloorPath } from '../storage-layout.js';
import { tenantOfPath } from '../video/ingest/video-brief.js';
import { KNOWLEDGE_TIER_RANK } from '../foundation/knowledge-tier.js';
import type { OcrResult } from '../ocr-types.js';
import type { TranscriptSegment } from '../voice/speech-to-text-bridge.js';

export interface PerceptionScope {
  tier: 'public' | 'confidential' | 'personal';
  tenant_slug?: string;
}
export interface PerceptionSource {
  path: string;
  sha256: string;
  scope: PerceptionScope;
}
export interface Observation {
  id: string;
  source: PerceptionSource;
  modality: 'image' | 'audio' | 'video';
  kind:
    | 'text'
    | 'description'
    | 'visual_change'
    | 'speech'
    | 'sound_event'
    | 'speaker'
    | 'face'
    | 'pose'
    | 'gesture';
  provider: string;
  finality: 'tentative' | 'final';
  text?: string;
  confidence?: number;
  time?: { start_sec: number; end_sec: number; basis: 'decoded' | 'sampled' | 'aligned' };
  region?: { x: number; y: number; width: number; height: number; units: 'normalized' };
  speaker_id?: string;
  attributes?: Record<string, unknown>;
}

/** Active scope is an authority boundary; path declarations only narrow it. */
export function resolvePerceptionScope(file: string): PerceptionScope {
  const absolute = assertSafeRepositoryPath(pathResolver.rootResolve(file));
  const active = resolveScopeContext();
  const inferred = inferImagePayloadTier(absolute);
  const tier =
    KNOWLEDGE_TIER_RANK[active.tier] > KNOWLEDGE_TIER_RANK[inferred] ? active.tier : inferred;
  const floor = classifyStorageFloorPath(absolute);
  const tenant = floor?.partition.kind === 'tier' ? floor.partition.tenant : tenantOfPath(absolute);
  if (tenant && tenant !== active.tenant_slug)
    throw new Error('[PERCEPTION_SCOPE] source tenant differs from active scope');
  if (tier !== 'public' && !active.tenant_slug)
    throw new Error('[PERCEPTION_SCOPE] private input requires an active tenant');
  return { tier, ...(active.tenant_slug ? { tenant_slug: active.tenant_slug } : {}) };
}

export function perceptionSource(file: string): PerceptionSource {
  const absolute = assertSafeRepositoryPath(pathResolver.rootResolve(file));
  const scope = resolvePerceptionScope(absolute);
  const before = safeLstat(absolute);
  if (!before.isFile() || before.size > 8 * 1024 * 1024 * 1024)
    throw new Error('[PERCEPTION_SOURCE_LIMIT] regular file <=8 GiB required');
  const hash = createHash('sha256');
  for (let offset = 0; offset < before.size; offset += 1048576)
    hash.update(safeReadFileRange(absolute, offset, Math.min(1048576, before.size - offset)));
  const after = safeLstat(absolute);
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs)
    throw new Error('[PERCEPTION_STALE] source changed while hashing');
  return {
    path: path.relative(pathResolver.rootDir(), absolute).split(path.sep).join('/'),
    sha256: hash.digest('hex'),
    scope,
  };
}

export function observation(
  source: PerceptionSource,
  fields: Omit<Observation, 'source' | 'id'>
): Observation {
  if (!fields.provider.trim()) throw new Error('[PERCEPTION_INVALID] missing provider');
  if (
    fields.confidence !== undefined &&
    (!Number.isFinite(fields.confidence) || fields.confidence < 0 || fields.confidence > 1)
  )
    throw new Error('[PERCEPTION_INVALID] confidence outside 0..1');
  if (
    fields.time &&
    (![fields.time.start_sec, fields.time.end_sec].every((v) => Number.isFinite(v) && v >= 0) ||
      fields.time.end_sec < fields.time.start_sec)
  )
    throw new Error('[PERCEPTION_INVALID] invalid time interval');
  if (fields.region) {
    const r = fields.region;
    if (
      ![r.x, r.y, r.width, r.height].every((v) => Number.isFinite(v) && v >= 0 && v <= 1) ||
      r.x + r.width > 1.000001 ||
      r.y + r.height > 1.000001
    )
      throw new Error('[PERCEPTION_INVALID] invalid normalized region');
  }
  const id = createHash('sha256')
    .update(JSON.stringify({ source, fields }))
    .digest('hex')
    .slice(0, 24);
  return { id, source, ...fields };
}

export function ocrObservations(
  source: PerceptionSource,
  ocr: OcrResult,
  size?: { width: number; height: number }
): Observation[] {
  const lines = ocr.lines?.length ? ocr.lines : [{ text: ocr.text, confidence: ocr.confidence }];
  return lines.map((line) => {
    const b = 'boundingBox' in line ? line.boundingBox : undefined;
    const normalized = ocr.boundingBoxUnits === 'normalized';
    const region =
      b && (normalized || size)
        ? {
            x: b.x / (normalized ? 1 : size!.width),
            y: b.y / (normalized ? 1 : size!.height),
            width: b.width / (normalized ? 1 : size!.width),
            height: b.height / (normalized ? 1 : size!.height),
            units: 'normalized' as const,
          }
        : undefined;
    return observation(source, {
      modality: 'image',
      kind: 'text',
      provider: ocr.provider,
      finality: 'final',
      text: line.text,
      confidence: Math.max(
        0,
        Math.min(1, line.confidence > 1 ? line.confidence / 100 : line.confidence)
      ),
      ...(region ? { region } : {}),
    });
  });
}
export function transcriptObservations(
  source: PerceptionSource,
  provider: string,
  segments: readonly (TranscriptSegment & {
    speaker_id?: string;
    speaker_ids?: string[];
    speaker_status?: 'tentative' | 'authoritative';
  })[]
): Observation[] {
  return segments.map((segment) =>
    observation(source, {
      modality: 'audio',
      kind: 'speech',
      provider,
      finality: 'final',
      text: segment.text,
      time: { start_sec: segment.start_sec, end_sec: segment.end_sec, basis: 'aligned' },
      ...(segment.speaker_id ? { speaker_id: segment.speaker_id } : {}),
      ...(segment.speaker_ids || segment.speaker_status
        ? {
            attributes: {
              speaker_ids: segment.speaker_ids ?? [],
              speaker_status: segment.speaker_status ?? 'tentative',
            },
          }
        : {}),
    })
  );
}

export function assertSourceUnchanged(source: PerceptionSource): void {
  const current = perceptionSource(source.path);
  if (
    current.sha256 !== source.sha256 ||
    current.scope.tier !== source.scope.tier ||
    current.scope.tenant_slug !== source.scope.tenant_slug
  )
    throw new Error(
      '[PERCEPTION_STALE] source changed during recognition; retry with stable input'
    );
}
