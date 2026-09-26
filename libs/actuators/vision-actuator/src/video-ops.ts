import {
  buildVideoBrief,
  type BuildVideoBriefOptions,
  type VideoIngestApprovalContext,
  type VideoIngestOutcome,
  type VideoSource,
  type VideoTier,
  type VideoTranscriptPreference,
} from '@agent/core/video-ingest';

/**
 * vision:fetch_video / vision:build_video_brief — thin op facades over the
 * governed core video ingest (policy hosts, egress, approval for remote
 * fetch, tier-safe cache). An approval_required outcome is returned so the
 * caller can obtain approval; a failed outcome throws with its code.
 */

export interface VideoOpParams {
  source?: VideoSource;
  url?: string;
  path?: string;
  language?: string;
  max_keyframes?: number;
  transcript_preference?: VideoTranscriptPreference;
  mission_id?: string;
  tenant_slug?: string;
  input_tier?: VideoTier;
  approval?: VideoIngestApprovalContext;
}

export interface VideoOpDeps {
  build?: (source: VideoSource, options: BuildVideoBriefOptions) => Promise<VideoIngestOutcome>;
}

const PREFERENCES: readonly VideoTranscriptPreference[] = ['auto', 'subtitles_only', 'stt_only'];
const TIERS: readonly VideoTier[] = ['public', 'confidential', 'personal'];

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function resolveVideoSource(params: VideoOpParams, op: string): VideoSource {
  const source = params.source;
  if (source && typeof source === 'object') {
    if (source.kind === 'url' && text(source.url)) return { kind: 'url', url: text(source.url) };
    if (source.kind === 'file' && text(source.path)) {
      return { kind: 'file', path: text(source.path) };
    }
    throw new Error(
      `[VIDEO_INVALID_PARAMS] ${op} source must be {kind:'url',url} or {kind:'file',path}`
    );
  }
  const url = text(params.url);
  const filePath = text(params.path);
  if (url && filePath) {
    throw new Error(`[VIDEO_INVALID_PARAMS] ${op} takes either url or path, not both`);
  }
  if (url) return { kind: 'url', url };
  if (filePath) return { kind: 'file', path: filePath };
  throw new Error(`[VIDEO_INVALID_PARAMS] ${op} requires source, url or path`);
}

function briefOptions(params: VideoOpParams, op: string): BuildVideoBriefOptions {
  const options: BuildVideoBriefOptions = {};
  if (params.language !== undefined) options.language = text(params.language) || undefined;
  if (params.max_keyframes !== undefined) {
    const max = Number(params.max_keyframes);
    if (!Number.isInteger(max) || max < 0) {
      throw new Error(`[VIDEO_INVALID_PARAMS] ${op} max_keyframes must be a non-negative integer`);
    }
    options.max_keyframes = max;
  }
  if (params.transcript_preference !== undefined) {
    if (!PREFERENCES.includes(params.transcript_preference)) {
      throw new Error(
        `[VIDEO_INVALID_PARAMS] ${op} transcript_preference must be one of ${PREFERENCES.join(', ')}`
      );
    }
    options.transcript_preference = params.transcript_preference;
  }
  if (params.input_tier !== undefined) {
    if (!TIERS.includes(params.input_tier)) {
      throw new Error(`[VIDEO_INVALID_PARAMS] ${op} input_tier must be one of ${TIERS.join(', ')}`);
    }
    options.input_tier = params.input_tier;
  }
  if (text(params.mission_id)) options.mission_id = text(params.mission_id);
  if (text(params.tenant_slug)) options.tenant_slug = text(params.tenant_slug);
  if (params.approval && text(params.approval.agent_id)) options.approval = params.approval;
  return options;
}

function toOpResult(outcome: VideoIngestOutcome) {
  if (outcome.status === 'ok') return { status: 'succeeded' as const, brief: outcome.brief };
  if (outcome.status === 'approval_required') {
    return {
      status: 'approval_required' as const,
      code: outcome.code,
      message: outcome.message,
      ...(outcome.request_id ? { request_id: outcome.request_id } : {}),
    };
  }
  const remediation = outcome.remediation ? ` (remediation: ${outcome.remediation})` : '';
  throw new Error(`[VIDEO_${outcome.code}] ${outcome.message}${remediation}`);
}

/** Remote capture: the source must be a URL. */
export async function handleFetchVideo(params: VideoOpParams, deps: VideoOpDeps = {}) {
  const source = resolveVideoSource(params ?? {}, 'fetch_video');
  if (source.kind !== 'url') {
    throw new Error(
      '[VIDEO_INVALID_PARAMS] fetch_video captures a remote url; use build_video_brief for local files'
    );
  }
  return toOpResult(
    await (deps.build ?? buildVideoBrief)(source, briefOptions(params, 'fetch_video'))
  );
}

/** Any source (url or local file) → VideoBrief. */
export async function handleBuildVideoBrief(params: VideoOpParams, deps: VideoOpDeps = {}) {
  const source = resolveVideoSource(params ?? {}, 'build_video_brief');
  return toOpResult(
    await (deps.build ?? buildVideoBrief)(source, briefOptions(params, 'build_video_brief'))
  );
}
