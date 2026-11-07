import * as path from 'node:path';
import { logger } from '@agent/core/core';
import { isValidTenantSlug } from '@agent/core/entity-scope';
import {
  PathAttributionError,
  canonicalRepoPath,
  classifyRepoPath,
  tenantOfPath as attributeTenantOfPath,
  tierOfPath as attributeTierOfPath,
  type ClassifiedPath,
} from '@agent/core/path-tenant-attribution';
import { evaluateEgressPolicy, type EgressPolicyDecision } from '@agent/core/egress-policy';
import { parseSafeJsonInput } from '@agent/core/foundation/safe-json';
import * as pathResolver from '@agent/core/path-resolver';
import {
  requireRiskyApproval,
  type RiskyApprovalRequest,
  type RiskyApprovalResult,
} from '@agent/core/risky-op-approval-port';
import {
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeReadFile,
  safeWriteFile,
} from '@agent/core/secure-io';
import { selectSpeechToTextBridges } from '@agent/core/voice/speech-to-text-bridge';
import { withLock } from '@agent/core/foundation/lock-utils';
import { getPlatformFacts, normalizePathForPlatformCompare } from '@agent/core/platform-facts';
import { resolveTenant } from '@agent/core/organization/tenant-registry';
import {
  resolveFfmpegBin,
  resolveFfprobeBin,
  resolveYtDlpBin,
} from '@agent/core/tool/tool-binary-resolvers';
import {
  assertLocalVideoWithinLimits,
  chooseSubtitleTrack,
  defaultVideoCommandRunner,
  downloadRemoteVideo,
  fetchRemoteVideoInfo,
  fileContentKey,
  findKeptSourceMedia,
  isVideoHostAllowed,
  loadVideoIngestPolicy,
  normalizeVideoUrl,
  probeLocalVideo,
  removeSourceMedia,
  sha256Hex,
  urlContentKey,
  type SubtitleChoice,
} from './video-fetch.js';
import {
  VideoIngestError,
  type TranscriptSegment,
  type VideoBrief,
  type VideoChapter,
  type VideoCommandRunner,
  type VideoIngestOutcome,
  type VideoIngestPolicy,
  type VideoMetadata,
  type VideoSource,
  type VideoTier,
  type VideoTranscript,
  type VideoTranscriptPreference,
} from './video-ingest-types.js';
import {
  detectSceneChanges,
  extractAudioWav,
  extractFrame,
  extractKeyframes,
  planKeyframes,
} from './video-media.js';
import { parseVtt } from './vtt-parser.js';

export const FETCH_VIDEO_APPROVAL_OP = 'vision:fetch_video';

import { KNOWLEDGE_TIER_RANK as TIER_RANK } from '@agent/core/foundation/knowledge-tier';

export interface VideoCachePlacement {
  scope: 'mission' | 'tenant' | 'shared';
  root: string;
  tier: VideoTier;
  /** Owning tenant; undefined for shared or tenant-less mission caches. */
  tenant_slug?: string;
}

function repoRelative(absPath: string): string {
  return path.relative(pathResolver.rootDir(), path.resolve(absPath)).split(path.sep).join('/');
}

/** Re-raise a path-attribution failure as the ingest error the brief reports. */
function asIngestError(error: unknown): unknown {
  return error instanceof PathAttributionError
    ? new VideoIngestError(error.code, error.detail)
    : error;
}

function attributed<T>(attribute: () => T): T {
  try {
    return attribute();
  } catch (error) {
    throw asIngestError(error);
  }
}

/** Canonical path; unresolvable symlinks and anything outside the repository fail closed. */
function canonicalPath(filePath: string): string {
  return attributed(() => canonicalRepoPath(filePath));
}

function classifyPath(filePath: string): ClassifiedPath {
  return attributed(() => classifyRepoPath(filePath));
}

/** Data tier implied by where a path lives (knowledge/ or active/ tier partitions). */
export function tierOfPath(filePath: string): VideoTier {
  return attributed(() => attributeTierOfPath(filePath));
}

/** Tenant owning a path (see `tenantOfPath` in `path-tenant-attribution`). */
export function tenantOfPath(filePath: string): string | undefined {
  return attributed(() => attributeTenantOfPath(filePath));
}

/** Throws unless the tenant is registered and operational. */
export type VideoTenantAuthorizer = (tenantSlug: string) => void;

const defaultTenantAuthorizer: VideoTenantAuthorizer = (tenantSlug) => {
  resolveTenant(tenantSlug);
};

/**
 * Mission-local when a mission is given, else the tenant's volatile area,
 * else the shared (public) cache. A caller-named tenant is authorized here:
 * alongside a mission it must be that mission's tenant, on its own it must
 * resolve in the tenant registry.
 */
export function resolveVideoCachePlacement(
  scope: { mission_id?: string; tenant_slug?: string } = {},
  authorizeTenant: VideoTenantAuthorizer = defaultTenantAuthorizer
): VideoCachePlacement {
  if (scope.tenant_slug !== undefined && !isValidTenantSlug(scope.tenant_slug)) {
    throw new VideoIngestError('INVALID_SOURCE', `invalid tenant slug '${scope.tenant_slug}'`);
  }
  if (scope.mission_id) {
    let missionId: string;
    try {
      missionId = pathResolver.assertVolatileId('mission', scope.mission_id);
    } catch (error) {
      throw new VideoIngestError('INVALID_SOURCE', (error as Error).message);
    }
    const missionPath = pathResolver.findMissionPath(missionId);
    if (!missionPath) {
      throw new VideoIngestError('INVALID_SOURCE', `mission '${missionId}' does not exist`);
    }
    const tenant = tenantOfPath(missionPath);
    if (scope.tenant_slug && scope.tenant_slug !== tenant) {
      throw new VideoIngestError(
        'TENANT_MISMATCH',
        `tenant '${scope.tenant_slug}' does not own mission '${missionId}' (${
          tenant ? `tenant '${tenant}'` : 'tenant-less mission'
        })`
      );
    }
    return {
      scope: 'mission',
      root: path.join(missionPath, 'cache', 'video'),
      tier: tierOfPath(missionPath),
      ...(tenant ? { tenant_slug: tenant } : {}),
    };
  }
  if (scope.tenant_slug) {
    try {
      authorizeTenant(scope.tenant_slug);
    } catch (error) {
      throw new VideoIngestError(
        'TENANT_UNRESOLVED',
        `tenant '${scope.tenant_slug}' is not a registered, operational tenant: ${(error as Error).message}`
      );
    }
    const tenantPath = pathResolver.volatile('tenant', scope.tenant_slug, { tier: 'confidential' });
    return {
      scope: 'tenant',
      root: path.join(tenantPath, 'cache', 'video-ingest'),
      tier: 'confidential',
      tenant_slug: scope.tenant_slug,
    };
  }
  return { scope: 'shared', root: pathResolver.shared('cache/video-ingest'), tier: 'public' };
}

/** Refuse to cache derived media in a lower tier than its input. */
export function assertNoTierDowngrade(inputTier: VideoTier, placement: VideoCachePlacement): void {
  if (TIER_RANK[inputTier] > TIER_RANK[placement.tier]) {
    throw new VideoIngestError(
      'TIER_DOWNGRADE',
      `${inputTier} input cannot be cached in the ${placement.tier} ${placement.scope} cache; pass mission_id or tenant_slug of the owning scope`
    );
  }
}

/** Refuse to cache one tenant's input under another tenant (or a tenant-less) cache. */
export function assertSameTenant(
  inputTenant: string | undefined,
  placement: VideoCachePlacement
): void {
  if (inputTenant && inputTenant !== placement.tenant_slug) {
    throw new VideoIngestError(
      'TENANT_MISMATCH',
      `input owned by tenant '${inputTenant}' cannot be cached in the ${placement.scope} cache${
        placement.tenant_slug ? ` of tenant '${placement.tenant_slug}'` : ''
      }; pass mission_id or tenant_slug of the owning tenant`
    );
  }
}

/**
 * Only the requesting agent is caller-supplied. Correlation id, channel and
 * human-presence are derived here so an approval cannot be replayed onto a
 * different fetch.
 */
export interface VideoIngestApprovalContext {
  agent_id: string;
}

/** What a remote-fetch approval authorizes: the exact URL, format and policy limits. */
export interface VideoFetchApprovalPayload {
  url: string;
  format: string;
  max_bytes: number;
  max_duration_sec: number;
}

/** A human decision on a fetch lapses after this long; the next call asks again. */
export const VIDEO_FETCH_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Approval correlation for one exact fetch: the content key (URL + format)
 * plus a hash of the approved payload, so a policy-limit change asks again
 * instead of colliding with the earlier request.
 */
export function videoFetchCorrelationId(
  contentKey: string,
  payload: VideoFetchApprovalPayload
): string {
  const payloadHash = sha256Hex(
    JSON.stringify([payload.url, payload.format, payload.max_bytes, payload.max_duration_sec])
  ).slice(0, 16);
  return `video-ingest:${contentKey}:${payloadHash}`;
}

export type VideoTranscribeFn = (
  audioPath: string,
  language: string | undefined
) => Promise<{ language?: string; segments: TranscriptSegment[] } | null>;

/** Caller-facing options; everything here may come from op params. */
export interface BuildVideoBriefOptions {
  language?: string;
  max_keyframes?: number;
  transcript_preference?: VideoTranscriptPreference;
  mission_id?: string;
  tenant_slug?: string;
  /** Declared tier of a local input; the stricter of this and its path tier wins. */
  input_tier?: VideoTier;
  /** Required for an uncached remote fetch when the policy demands approval. */
  approval?: VideoIngestApprovalContext;
  /** Keep downloaded remote media in the cache entry after derivation (default: delete). */
  keep_source?: boolean;
}

/**
 * Test seams (tools, policy, placement, gates, clock). Never derived from op
 * params: only buildVideoBriefWithInternals accepts them.
 */
export interface VideoBriefInternals {
  runner?: VideoCommandRunner;
  policy?: VideoIngestPolicy;
  cachePlacement?: VideoCachePlacement;
  authorizeTenant?: VideoTenantAuthorizer;
  transcribe?: VideoTranscribeFn;
  evaluateEgress?: (url: string) => EgressPolicyDecision;
  requestApproval?: (request: RiskyApprovalRequest) => RiskyApprovalResult;
  /** Clock for the requested approval expiry (default Date.now); the gate clamps it. */
  now?: () => number;
  bins?: { yt_dlp?: string; ffmpeg?: string; ffprobe?: string };
}

/** Default STT: a registered bridge that declares segment timestamps. */
export const defaultVideoTranscribe: VideoTranscribeFn = async (audioPath, language) => {
  let selection;
  try {
    selection = selectSpeechToTextBridges({
      requires: { timestamps: 'segment', ...(language ? { language } : {}) },
    });
  } catch (error) {
    logger.warn(
      `[video-ingest] no timestamped STT bridge: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
  const bridge = selection.bridges[0];
  if (!bridge) return null;
  const result = await bridge.transcribe({
    audioPath,
    ...(language ? { language } : {}),
    outputPath: `${audioPath}.transcript.txt`,
  });
  if (!result.segments?.length) return null;
  return { ...(result.language ? { language: result.language } : {}), segments: result.segments };
};

function briefVariantKey(options: BuildVideoBriefOptions, maxKeyframes: number): string {
  return sha256Hex(
    JSON.stringify({
      language: options.language ?? null,
      max_keyframes: maxKeyframes,
      transcript_preference: options.transcript_preference ?? 'auto',
    })
  ).slice(0, 12);
}

function readCachedBrief(briefPath: string): VideoBrief | null {
  if (!safeExistsSync(briefPath)) return null;
  try {
    const parsed = parseSafeJsonInput(
      safeReadFile(briefPath, { encoding: 'utf8' }) as string,
      'cached video brief'
    ) as VideoBrief;
    return parsed && typeof parsed.content_key === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

function approvalRequired(message: string, requestId?: string): VideoIngestOutcome {
  return {
    status: 'approval_required',
    code: 'APPROVAL_REQUIRED',
    message,
    ...(requestId ? { request_id: requestId } : {}),
  };
}

interface PreparedMedia {
  metadata: VideoMetadata;
  chapters: VideoChapter[];
  media_path: string;
  subtitle?: SubtitleChoice & { path: string };
  language?: string;
}

async function transcriptFor(
  prepared: PreparedMedia,
  preference: VideoTranscriptPreference,
  audio: () => Promise<string | null>,
  transcribe: VideoTranscribeFn,
  requestedLanguage: string | undefined,
  warnings: string[]
): Promise<VideoTranscript | null> {
  if (prepared.subtitle && preference !== 'stt_only') {
    const segments = parseVtt(
      safeReadFile(prepared.subtitle.path, { encoding: 'utf8' }) as string,
      {
        dedupeRolling: prepared.subtitle.origin === 'auto_subs',
      }
    );
    if (segments.length > 0) {
      return { origin: prepared.subtitle.origin, language: prepared.subtitle.lang, segments };
    }
    warnings.push(`subtitle track ${prepared.subtitle.lang} was empty`);
  }
  if (preference === 'subtitles_only') {
    warnings.push('no subtitle track available and transcript_preference is subtitles_only');
    return null;
  }
  const audioPath = await audio();
  if (!audioPath) return null;
  const language = requestedLanguage ?? prepared.language;
  const result = await transcribe(audioPath, language);
  if (!result || result.segments.length === 0) {
    warnings.push('no timestamped speech-to-text result available');
    return null;
  }
  return {
    origin: 'stt',
    language: result.language ?? language ?? 'und',
    segments: result.segments,
  };
}

/** Upper bound on waiting for another run on the same cache entry (download + derivation). */
export const VIDEO_ENTRY_LOCK_TIMEOUT_MS = 45 * 60_000;

/**
 * Lock resource for a cache entry, keyed by its canonical path — lower-cased
 * on case-insensitive platforms so `Entry` and `entry` share one lock.
 */
export function videoEntryLockResource(
  entryDir: string,
  platform: NodeJS.Platform = process.platform
): string {
  const canonical = canonicalPath(entryDir);
  const key = normalizePathForPlatformCompare(canonical, getPlatformFacts(platform));
  return `video-ingest-${sha256Hex(key).slice(0, 32)}`;
}

async function withVideoEntryLock<T>(entryDir: string, fn: () => Promise<T>): Promise<T> {
  const resource = videoEntryLockResource(entryDir);
  try {
    return await withLock(resource, fn, VIDEO_ENTRY_LOCK_TIMEOUT_MS);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('[LOCK_TIMEOUT]')) {
      throw new VideoIngestError('TOOL_FAILED', 'video cache entry is busy with another run');
    }
    throw error;
  }
}

/** Subtitle track a previous run left beside kept source media. */
function keptSubtitle(
  entryDir: string,
  subtitle: SubtitleChoice | null
): { subtitle_path?: string } {
  if (!subtitle) return {};
  const subtitlePath = path.join(entryDir, `source.${subtitle.lang}.vtt`);
  return safeExistsSync(subtitlePath) ? { subtitle_path: subtitlePath } : {};
}

/**
 * source → VideoBrief (metadata, chapters, transcript, keyframes). Results
 * are cached per content key; a cache hit touches neither the network nor
 * any external command.
 */
export async function buildVideoBrief(
  source: VideoSource,
  options: BuildVideoBriefOptions = {}
): Promise<VideoIngestOutcome> {
  return buildVideoBriefWithInternals(source, options, {});
}

/** buildVideoBrief with test seams; not for op facades. */
export async function buildVideoBriefWithInternals(
  source: VideoSource,
  options: BuildVideoBriefOptions,
  internals: VideoBriefInternals
): Promise<VideoIngestOutcome> {
  try {
    return await buildVideoBriefUnchecked(source, options, internals);
  } catch (error) {
    if (error instanceof VideoIngestError) {
      return {
        status: 'failed',
        code: error.code,
        message: error.message,
        ...(error.remediation ? { remediation: error.remediation } : {}),
      };
    }
    throw error;
  }
}

async function buildVideoBriefUnchecked(
  source: VideoSource,
  options: BuildVideoBriefOptions,
  internals: VideoBriefInternals
): Promise<VideoIngestOutcome> {
  const policy = internals.policy ?? loadVideoIngestPolicy();
  const runner = internals.runner ?? defaultVideoCommandRunner;
  const maxKeyframes = options.max_keyframes ?? policy.default_max_keyframes;
  const preference = options.transcript_preference ?? 'auto';
  const warnings: string[] = [];

  let contentKey: string;
  let inputTier: VideoTier;
  let inputTenant: string | undefined;
  let normalizedSource: VideoSource;
  let url: URL | null = null;
  let localPath: string | null = null;
  if (source.kind === 'url') {
    const normalized = normalizeVideoUrl(source.url);
    url = new URL(normalized);
    if (!isVideoHostAllowed(url.hostname, policy.allowed_hosts)) {
      throw new VideoIngestError(
        'HOST_NOT_ALLOWED',
        `${url.hostname} is not in video-ingest allowed_hosts`
      );
    }
    contentKey = urlContentKey(normalized, policy.download_format);
    inputTier = 'public';
    normalizedSource = { kind: 'url', url: normalized };
  } else {
    const requested = path.resolve(pathResolver.rootDir(), source.path);
    // Refuse a symlinked input, then work only on the canonical path so the
    // file classified, hashed and probed is the one the tools read.
    let isLink = false;
    try {
      isLink = safeLstat(requested).isSymbolicLink();
    } catch (error) {
      // A missing input is reported by the size check below.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
    }
    if (isLink) {
      throw new VideoIngestError('INVALID_SOURCE', `${source.path} is a symbolic link`);
    }
    localPath = canonicalPath(requested);
    assertLocalVideoWithinLimits(localPath, policy.max_bytes);
    const pathTier = tierOfPath(localPath);
    const declared = options.input_tier ?? 'public';
    inputTier = TIER_RANK[declared] > TIER_RANK[pathTier] ? declared : pathTier;
    inputTenant = tenantOfPath(localPath);
    normalizedSource = { kind: 'file', path: classifyPath(localPath).rel };
    contentKey = '';
  }

  const placement =
    internals.cachePlacement ??
    resolveVideoCachePlacement(
      { mission_id: options.mission_id, tenant_slug: options.tenant_slug },
      internals.authorizeTenant
    );
  assertNoTierDowngrade(inputTier, placement);
  assertSameTenant(inputTenant, placement);
  if (localPath) contentKey = fileContentKey(localPath, policy.max_bytes);

  const entryDir = path.join(placement.root, contentKey);
  const briefPath = path.join(entryDir, `brief-${briefVariantKey(options, maxKeyframes)}.json`);
  const cached = readCachedBrief(briefPath);
  if (cached) return { status: 'ok', brief: { ...cached, cache_hit: true } };

  if (url) {
    const decision = (internals.evaluateEgress ?? evaluateEgressPolicy)(url.toString());
    if (decision.verdict === 'deny') {
      throw new VideoIngestError('EGRESS_DENIED', decision.reason);
    }
    if (decision.verdict === 'warn') {
      logger.warn(`[video-ingest] egress warn for ${url.hostname}: ${decision.reason}`);
      warnings.push(`egress warn: ${decision.reason}`);
    }
    if (policy.require_approval_for_remote) {
      if (!options.approval) {
        return approvalRequired(
          `remote video fetch from ${url.hostname} requires approval (video-ingest-policy require_approval_for_remote)`
        );
      }
      // The gate creates human_only requests bound to this op id and the
      // payload hash; the payload pins the exact fetch (URL, format, limits).
      // Requests expire, so a rejection or an old approval is not permanent.
      const payload: VideoFetchApprovalPayload = {
        url: url.toString(),
        format: policy.download_format,
        max_bytes: policy.max_bytes,
        max_duration_sec: policy.max_duration_sec,
      };
      const now = (internals.now ?? Date.now)();
      const decisionResult = (internals.requestApproval ?? requireRiskyApproval)({
        opId: FETCH_VIDEO_APPROVAL_OP,
        agentId: options.approval.agent_id,
        correlationId: videoFetchCorrelationId(contentKey, payload),
        channel: 'system',
        payload: { ...payload },
        expiresAt: new Date(now + VIDEO_FETCH_APPROVAL_TTL_MS).toISOString(),
        draft: {
          title: `Remote video fetch: ${url.hostname}`,
          summary: `Download ${url.toString()} (metadata, subtitles, media) for video ingest.`,
          severity: 'medium',
        },
      });
      if (!decisionResult.allowed) {
        return approvalRequired(
          decisionResult.message ?? `approval for remote video fetch is ${decisionResult.status}`,
          decisionResult.requestId
        );
      }
    }
  } else if (!localPath) {
    throw new VideoIngestError('INVALID_SOURCE', 'video source has neither a url nor a path');
  }

  const deriveBrief = async (): Promise<VideoIngestOutcome> => {
    let prepared: PreparedMedia;
    let downloadedMedia = false;
    if (url) {
      const ytDlp = internals.bins?.yt_dlp ?? resolveYtDlpBin();
      const info = await fetchRemoteVideoInfo(
        runner,
        ytDlp,
        url.toString(),
        policy.download_format
      );
      if (info.is_live) {
        throw new VideoIngestError('LIVE_STREAM', 'live or upcoming streams cannot be ingested');
      }
      if (!info.duration_known) {
        throw new VideoIngestError(
          'DURATION_UNKNOWN',
          'remote video reports no duration; refusing to download an unbounded stream'
        );
      }
      if (info.metadata.duration_sec > policy.max_duration_sec) {
        throw new VideoIngestError(
          'DURATION_EXCEEDED',
          `video is ${info.metadata.duration_sec}s (policy max_duration_sec ${policy.max_duration_sec})`
        );
      }
      if (info.approx_bytes !== undefined && info.approx_bytes > policy.max_bytes) {
        throw new VideoIngestError(
          'SIZE_EXCEEDED',
          `video is ~${info.approx_bytes} bytes (policy max_bytes ${policy.max_bytes})`
        );
      }
      const subtitle =
        preference === 'stt_only'
          ? null
          : chooseSubtitleTrack(info, options.language ?? info.language ?? 'en');
      safeMkdir(entryDir, { recursive: true });
      // Reuse media an earlier keep_source run left here rather than fetching
      // again (a failed re-download would otherwise delete the kept copy).
      const keptMedia = findKeptSourceMedia(entryDir);
      const download = keptMedia
        ? { media_path: keptMedia, ...keptSubtitle(entryDir, subtitle) }
        : await downloadRemoteVideo(runner, ytDlp, url.toString(), entryDir, {
            format: policy.download_format,
            maxBytes: policy.max_bytes,
            subtitle,
            ffmpegBin: internals.bins?.ffmpeg ?? resolveFfmpegBin(),
          });
      downloadedMedia = !keptMedia;
      prepared = {
        metadata: info.metadata,
        chapters: info.chapters,
        media_path: download.media_path,
        ...(subtitle && download.subtitle_path
          ? { subtitle: { ...subtitle, path: download.subtitle_path } }
          : {}),
        ...(info.language ? { language: info.language } : {}),
      };
      if (subtitle && !download.subtitle_path)
        warnings.push(`subtitle track ${subtitle.lang} was not written`);
    } else if (localPath) {
      const mediaPath = localPath;
      const info = await probeLocalVideo(
        runner,
        internals.bins?.ffprobe ?? resolveFfprobeBin(),
        mediaPath
      );
      if (info.metadata.duration_sec > policy.max_duration_sec) {
        throw new VideoIngestError(
          'DURATION_EXCEEDED',
          `video is ${info.metadata.duration_sec}s (policy max_duration_sec ${policy.max_duration_sec})`
        );
      }
      safeMkdir(entryDir, { recursive: true });
      prepared = { metadata: info.metadata, chapters: info.chapters, media_path: mediaPath };
    } else {
      throw new VideoIngestError('INVALID_SOURCE', 'video source has neither a url nor a path');
    }

    // Retention: derived artifacts (audio, frames, subtitles, brief) stay in
    // the cache entry; downloaded source media is dropped after derivation —
    // success or failure — unless keep_source. A local input is never touched.
    try {
      const ffmpeg = internals.bins?.ffmpeg ?? resolveFfmpegBin();
      let audioPath: string | undefined;
      const transcript = await transcriptFor(
        prepared,
        preference,
        async () => {
          try {
            audioPath = await extractAudioWav(
              runner,
              ffmpeg,
              prepared.media_path,
              path.join(entryDir, 'audio.wav')
            );
            return audioPath;
          } catch (error) {
            warnings.push(
              `audio extraction failed: ${error instanceof Error ? error.message : String(error)}`
            );
            return null;
          }
        },
        internals.transcribe ?? defaultVideoTranscribe,
        options.language,
        warnings
      );

      const duration = prepared.metadata.duration_sec;
      const thumbnailPath = await extractFrame(
        runner,
        ffmpeg,
        prepared.media_path,
        path.join(entryDir, 'thumbnail.jpg'),
        Math.min(duration * 0.1, 10)
      );

      let sceneTimes: number[] = [];
      if (maxKeyframes > 0) {
        try {
          sceneTimes = await detectSceneChanges(
            runner,
            ffmpeg,
            prepared.media_path,
            policy.scene_threshold
          );
        } catch (error) {
          warnings.push(
            `scene detection failed: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
      const plan = planKeyframes({
        duration_sec: duration,
        chapters: prepared.chapters,
        scene_times: sceneTimes,
        interval_sec: policy.keyframe_interval_sec,
        max_keyframes: maxKeyframes,
      });
      const keyframes = await extractKeyframes(runner, ffmpeg, prepared.media_path, entryDir, plan);

      const brief: VideoBrief = {
        source: normalizedSource,
        content_key: contentKey,
        metadata: prepared.metadata,
        chapters: prepared.chapters,
        transcript,
        keyframes: keyframes.map((frame) => ({ ...frame, path: repoRelative(frame.path) })),
        thumbnail_path: repoRelative(thumbnailPath),
        ...(audioPath ? { audio_path: repoRelative(audioPath) } : {}),
        cache_hit: false,
        warnings,
      };
      safeWriteFile(briefPath, `${JSON.stringify(brief, null, 2)}\n`);
      return { status: 'ok', brief };
    } finally {
      if (downloadedMedia && !options.keep_source) removeSourceMedia(entryDir);
    }
  };

  // One writer per cache entry: download, derivation and source cleanup never
  // interleave with another run on the same entry (which could delete media
  // mid-derivation). A waiter re-checks the cache once it holds the lock.
  return withVideoEntryLock(entryDir, async () => {
    const cachedNow = readCachedBrief(briefPath);
    if (cachedNow) return { status: 'ok', brief: { ...cachedNow, cache_hit: true } };
    return deriveBrief();
  });
}
