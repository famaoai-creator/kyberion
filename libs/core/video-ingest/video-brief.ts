import * as path from 'node:path';
import { logger } from '../core.js';
import { isValidTenantSlug } from '../entity-scope.js';
import { evaluateEgressPolicy, type EgressPolicyDecision } from '../egress-policy.js';
import { parseSafeJsonInput } from '../foundation/safe-json.js';
import * as pathResolver from '../path-resolver.js';
import {
  requireRiskyApproval,
  type RiskyApprovalRequest,
  type RiskyApprovalResult,
} from '../risky-op-approval-port.js';
import { safeExistsSync, safeMkdir, safeReadFile, safeWriteFile } from '../secure-io.js';
import { selectSpeechToTextBridges } from '../speech-to-text-bridge.js';
import { resolveFfmpegBin, resolveFfprobeBin, resolveYtDlpBin } from '../tool-binary-resolvers.js';
import {
  assertLocalVideoWithinLimits,
  chooseSubtitleTrack,
  defaultVideoCommandRunner,
  downloadRemoteVideo,
  fetchRemoteVideoInfo,
  fileContentKey,
  isVideoHostAllowed,
  loadVideoIngestPolicy,
  normalizeVideoUrl,
  probeLocalVideo,
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

const TIER_RANK: Record<VideoTier, number> = { public: 0, confidential: 1, personal: 2 };

export interface VideoCachePlacement {
  scope: 'mission' | 'tenant' | 'shared';
  root: string;
  tier: VideoTier;
}

function repoRelative(absPath: string): string {
  return path.relative(pathResolver.rootDir(), path.resolve(absPath)).split(path.sep).join('/');
}

/** Data tier implied by where a path lives (knowledge/ or active/ tier partitions). */
export function tierOfPath(filePath: string): VideoTier {
  const rel = repoRelative(filePath);
  const match =
    /^knowledge\/(personal|confidential|public)(?:\/|$)/.exec(rel) ??
    /^active\/(?:missions|projects|organizations)\/(personal|confidential|public)(?:\/|$)/.exec(
      rel
    );
  if (match) return match[1] as VideoTier;
  if (/^(?:active\/personal|vault)(?:\/|$)/.test(rel)) return 'personal';
  return 'public';
}

/**
 * Mission-local when a mission is given, else the tenant's volatile area,
 * else the shared (public) cache.
 */
export function resolveVideoCachePlacement(
  scope: { mission_id?: string; tenant_slug?: string } = {}
): VideoCachePlacement {
  if (scope.mission_id) {
    const missionPath = pathResolver.volatile('mission', scope.mission_id);
    return {
      scope: 'mission',
      root: path.join(missionPath, 'cache', 'video'),
      tier: tierOfPath(missionPath),
    };
  }
  if (scope.tenant_slug) {
    if (!isValidTenantSlug(scope.tenant_slug)) {
      throw new VideoIngestError('INVALID_SOURCE', `invalid tenant slug '${scope.tenant_slug}'`);
    }
    const tenantPath = pathResolver.volatile('tenant', scope.tenant_slug, { tier: 'confidential' });
    return {
      scope: 'tenant',
      root: path.join(tenantPath, 'cache', 'video-ingest'),
      tier: 'confidential',
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

export interface VideoIngestApprovalContext {
  agent_id: string;
  channel?: string;
  correlation_id?: string;
  has_human?: boolean;
  has_ui?: boolean;
  non_interactive?: boolean;
}

export type VideoTranscribeFn = (
  audioPath: string,
  language: string | undefined
) => Promise<{ language?: string; segments: TranscriptSegment[] } | null>;

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
  runner?: VideoCommandRunner;
  policy?: VideoIngestPolicy;
  cachePlacement?: VideoCachePlacement;
  transcribe?: VideoTranscribeFn;
  evaluateEgress?: (url: string) => EgressPolicyDecision;
  requestApproval?: (request: RiskyApprovalRequest) => RiskyApprovalResult;
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
    const segments = parseVtt(safeReadFile(prepared.subtitle.path, { encoding: 'utf8' }) as string);
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

/**
 * source → VideoBrief (metadata, chapters, transcript, keyframes). Results
 * are cached per content key; a cache hit touches neither the network nor
 * any external command.
 */
export async function buildVideoBrief(
  source: VideoSource,
  options: BuildVideoBriefOptions = {}
): Promise<VideoIngestOutcome> {
  try {
    return await buildVideoBriefUnchecked(source, options);
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
  options: BuildVideoBriefOptions
): Promise<VideoIngestOutcome> {
  const policy = options.policy ?? loadVideoIngestPolicy();
  const runner = options.runner ?? defaultVideoCommandRunner;
  const maxKeyframes = options.max_keyframes ?? policy.default_max_keyframes;
  const preference = options.transcript_preference ?? 'auto';
  const warnings: string[] = [];

  let contentKey: string;
  let inputTier: VideoTier;
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
    localPath = path.resolve(pathResolver.rootDir(), source.path);
    assertLocalVideoWithinLimits(localPath, policy.max_bytes);
    const pathTier = tierOfPath(localPath);
    const declared = options.input_tier ?? 'public';
    inputTier = TIER_RANK[declared] > TIER_RANK[pathTier] ? declared : pathTier;
    normalizedSource = { kind: 'file', path: repoRelative(localPath) };
    contentKey = '';
  }

  const placement =
    options.cachePlacement ??
    resolveVideoCachePlacement({
      mission_id: options.mission_id,
      tenant_slug: options.tenant_slug,
    });
  assertNoTierDowngrade(inputTier, placement);
  if (localPath) contentKey = fileContentKey(localPath, policy.max_bytes);

  const entryDir = path.join(placement.root, contentKey);
  const briefPath = path.join(entryDir, `brief-${briefVariantKey(options, maxKeyframes)}.json`);
  const cached = readCachedBrief(briefPath);
  if (cached) return { status: 'ok', brief: { ...cached, cache_hit: true } };

  let prepared: PreparedMedia;
  if (url) {
    const decision = (options.evaluateEgress ?? evaluateEgressPolicy)(url.toString());
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
      const approval = options.approval;
      const decisionResult = (options.requestApproval ?? requireRiskyApproval)({
        opId: FETCH_VIDEO_APPROVAL_OP,
        agentId: approval.agent_id,
        correlationId: approval.correlation_id ?? `video-ingest:${contentKey}`,
        channel: approval.channel ?? 'system',
        ...(approval.has_human !== undefined ? { hasHuman: approval.has_human } : {}),
        ...(approval.has_ui !== undefined ? { hasUI: approval.has_ui } : {}),
        ...(approval.non_interactive !== undefined
          ? { nonInteractive: approval.non_interactive }
          : {}),
        payload: { url: url.toString(), host: url.hostname, content_key: contentKey },
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
    const ytDlp = options.bins?.yt_dlp ?? resolveYtDlpBin();
    const info = await fetchRemoteVideoInfo(runner, ytDlp, url.toString());
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
    const download = await downloadRemoteVideo(runner, ytDlp, url.toString(), entryDir, {
      format: policy.download_format,
      maxBytes: policy.max_bytes,
      subtitle,
    });
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
      options.bins?.ffprobe ?? resolveFfprobeBin(),
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

  const ffmpeg = options.bins?.ffmpeg ?? resolveFfmpegBin();
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
    options.transcribe ?? defaultVideoTranscribe,
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
}
