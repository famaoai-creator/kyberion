import type { TranscriptSegment } from '../speech-to-text-bridge.js';

export type { TranscriptSegment };

export type VideoSource = { kind: 'url'; url: string } | { kind: 'file'; path: string };

export type VideoTier = 'public' | 'confidential' | 'personal';

export type VideoTranscriptOrigin = 'manual_subs' | 'auto_subs' | 'stt';

export type VideoTranscriptPreference = 'auto' | 'subtitles_only' | 'stt_only';

export interface VideoChapter {
  start_sec: number;
  end_sec: number;
  title: string;
}

export interface VideoMetadata {
  title: string;
  duration_sec: number;
  uploader?: string;
  license?: string;
}

export interface VideoTranscript {
  origin: VideoTranscriptOrigin;
  language: string;
  segments: TranscriptSegment[];
}

export type VideoKeyframeReason = 'chapter' | 'scene' | 'interval';

export interface VideoKeyframe {
  t_sec: number;
  /** Repo-relative, forward-slash path. */
  path: string;
  reason: VideoKeyframeReason;
}

export interface VideoBrief {
  source: VideoSource;
  content_key: string;
  metadata: VideoMetadata;
  chapters: VideoChapter[];
  /** Null when neither subtitles nor a timestamped STT result were available. */
  transcript: VideoTranscript | null;
  keyframes: VideoKeyframe[];
  thumbnail_path?: string;
  audio_path?: string;
  cache_hit: boolean;
  warnings: string[];
}

/** Result of one external command; mirrors secure-io's exec result shape. */
export interface VideoCommandResult {
  stdout: string;
  stderr: string;
  status: number | null;
  error?: Error;
}

export interface VideoCommandOptions {
  cwd?: string;
  timeoutMs?: number;
  maxOutputMB?: number;
}

/** Every yt-dlp / ffmpeg / ffprobe invocation goes through this seam. */
export type VideoCommandRunner = (
  command: string,
  args: string[],
  options?: VideoCommandOptions
) => Promise<VideoCommandResult>;

export interface VideoIngestPolicy {
  version: string;
  description?: string;
  /** Hosts (and their subdomains) remote fetch may target. Empty = no remote fetch. */
  allowed_hosts: string[];
  max_duration_sec: number;
  max_bytes: number;
  require_approval_for_remote: boolean;
  default_max_keyframes: number;
  keyframe_interval_sec: number;
  scene_threshold: number;
  download_format: string;
}

export type VideoIngestFailureCode =
  | 'INVALID_SOURCE'
  | 'HOST_NOT_ALLOWED'
  | 'EGRESS_DENIED'
  | 'DURATION_EXCEEDED'
  | 'DURATION_UNKNOWN'
  | 'LIVE_STREAM'
  | 'SIZE_EXCEEDED'
  | 'EXTRACTOR_OUTDATED'
  | 'TIER_DOWNGRADE'
  | 'TIER_UNRESOLVED'
  | 'TENANT_MISMATCH'
  | 'TENANT_UNRESOLVED'
  | 'TOOL_FAILED';

export type VideoIngestOutcome =
  | { status: 'ok'; brief: VideoBrief }
  | {
      status: 'approval_required';
      code: 'APPROVAL_REQUIRED';
      message: string;
      request_id?: string;
    }
  | {
      status: 'failed';
      code: VideoIngestFailureCode;
      message: string;
      remediation?: string;
    };

export class VideoIngestError extends Error {
  constructor(
    readonly code: VideoIngestFailureCode,
    message: string,
    readonly remediation?: string
  ) {
    super(`[${code}] ${message}`);
    this.name = 'VideoIngestError';
  }
}
