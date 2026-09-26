import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { defineCatalog } from '../foundation/governed-catalog.js';
import { parseSafeJsonInput } from '../foundation/safe-json.js';
import { isRecord } from '../foundation/text.js';
import * as pathResolver from '../path-resolver.js';
import {
  safeExecResultAsync,
  safeExistsSync,
  safeReaddir,
  safeRmSync,
  safeStat,
  safeReadFileRange,
} from '../secure-io.js';
import type {
  VideoChapter,
  VideoCommandResult,
  VideoCommandRunner,
  VideoIngestPolicy,
  VideoMetadata,
  VideoTranscriptOrigin,
} from './video-ingest-types.js';
import { VideoIngestError } from './video-ingest-types.js';

export const VIDEO_INGEST_POLICY_REPO_PATH =
  'knowledge/product/governance/video-ingest-policy.json';

export const YT_DLP_UPDATE_REMEDIATION =
  'Bump managed_binary.version (and checksums) in knowledge/product/governance/tool-runtimes/yt_dlp.json, then run: pnpm tool:setup -- --tool yt_dlp --apply';

const policyCatalog = defineCatalog<VideoIngestPolicy>({
  id: 'video-ingest-policy',
  path: () => pathResolver.rootResolve(VIDEO_INGEST_POLICY_REPO_PATH),
  schema: pathResolver.knowledge('product/schemas/video-ingest-policy.schema.json'),
});

export function loadVideoIngestPolicy(): VideoIngestPolicy {
  return policyCatalog.load();
}

export function _resetVideoIngestPolicyCacheForTests(): void {
  policyCatalog.reset();
}

/** Default runner: the governed secure-io exec boundary (async, no shell). */
export const defaultVideoCommandRunner: VideoCommandRunner = (command, args, options = {}) =>
  safeExecResultAsync(command, args, {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    timeoutMs: options.timeoutMs ?? 120_000,
    maxOutputMB: options.maxOutputMB ?? 20,
  });

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Lower-case host, drop fragment and utm_* tracking params, sort the query. */
export function normalizeVideoUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new VideoIngestError('INVALID_SOURCE', `not a valid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new VideoIngestError('INVALID_SOURCE', `unsupported URL scheme: ${parsed.protocol}`);
  }
  parsed.hash = '';
  const params = [...parsed.searchParams.entries()]
    .filter(([key]) => !key.toLowerCase().startsWith('utm_'))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  parsed.search = '';
  for (const [key, value] of params) parsed.searchParams.append(key, value);
  return parsed.toString();
}

export function urlContentKey(url: string, format: string): string {
  return sha256Hex(`${normalizeVideoUrl(url)}\n${format}`);
}

export function isVideoHostAllowed(hostname: string, allowedHosts: string[]): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '');
  return allowedHosts.some((entry) => {
    const allowed = entry.trim().toLowerCase().replace(/^\.+/, '');
    return allowed.length > 0 && (host === allowed || host.endsWith(`.${allowed}`));
  });
}

export function assertLocalVideoWithinLimits(filePath: string, maxBytes: number): number {
  if (!safeExistsSync(filePath)) {
    throw new VideoIngestError('INVALID_SOURCE', `video file not found: ${filePath}`);
  }
  const stat = safeStat(filePath);
  if (!stat.isFile()) throw new VideoIngestError('INVALID_SOURCE', `not a file: ${filePath}`);
  if (stat.size > maxBytes) {
    throw new VideoIngestError(
      'SIZE_EXCEEDED',
      `${filePath} is ${stat.size} bytes (policy max_bytes ${maxBytes})`
    );
  }
  return stat.size;
}

/** Reads `length` bytes at `position`; may return fewer at end of file. */
export type VideoFileRangeReader = (filePath: string, position: number, length: number) => Buffer;

export const VIDEO_HASH_CHUNK_BYTES = 8 * 1024 * 1024;

/** sha256 over fixed-size chunks so a large local video is never held in memory at once. */
export function sha256FileChunked(
  filePath: string,
  size: number,
  readRange: VideoFileRangeReader,
  chunkBytes: number = VIDEO_HASH_CHUNK_BYTES
): string {
  const hash = createHash('sha256');
  let position = 0;
  while (position < size) {
    const chunk = readRange(filePath, position, Math.min(chunkBytes, size - position));
    if (chunk.length === 0) break;
    hash.update(chunk);
    position += chunk.length;
  }
  if (position !== size) {
    throw new VideoIngestError('TOOL_FAILED', `${filePath} changed while hashing`);
  }
  return hash.digest('hex');
}

export function fileContentKey(
  filePath: string,
  maxBytes: number,
  readRange?: VideoFileRangeReader
): string {
  const size = assertLocalVideoWithinLimits(filePath, maxBytes);
  return sha256FileChunked(
    filePath,
    size,
    readRange ?? ((p, position, length) => safeReadFileRange(p, position, length))
  );
}

const EXTRACTOR_FAILURE_MARKERS = [
  'Unsupported URL',
  'ExtractorError',
  'HTTP Error 403',
  'Unable to extract',
];

/**
 * yt-dlp failures that usually mean the site changed under a stale extractor.
 * Never answered by self-update (`-U` needs network and mutates the managed
 * binary); the remediation is a governed registry bump + tool:setup.
 */
export function classifyYtDlpFailure(output: string): 'EXTRACTOR_OUTDATED' | 'TOOL_FAILED' {
  return EXTRACTOR_FAILURE_MARKERS.some((marker) => output.includes(marker))
    ? 'EXTRACTOR_OUTDATED'
    : 'TOOL_FAILED';
}

function commandFailure(tool: string, result: VideoCommandResult): VideoIngestError {
  const detail = (result.stderr || result.error?.message || '').trim().slice(0, 500);
  if (tool === 'yt-dlp' && classifyYtDlpFailure(detail) === 'EXTRACTOR_OUTDATED') {
    return new VideoIngestError(
      'EXTRACTOR_OUTDATED',
      `yt-dlp extractor failed: ${detail}`,
      YT_DLP_UPDATE_REMEDIATION
    );
  }
  return new VideoIngestError(
    'TOOL_FAILED',
    `${tool} exited with status ${result.status}: ${detail}`
  );
}

export async function runVideoTool(
  runner: VideoCommandRunner,
  tool: string,
  command: string,
  args: string[],
  options: { timeoutMs?: number; maxOutputMB?: number } = {}
): Promise<VideoCommandResult> {
  const result = await runner(command, args, options);
  if (result.error || result.status !== 0) throw commandFailure(tool, result);
  return result;
}

function numberOf(value: unknown): number | undefined {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : undefined;
}

function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export interface RemoteVideoInfo {
  metadata: VideoMetadata;
  /** False when yt-dlp reported no usable duration (live or unknown length). */
  duration_known: boolean;
  is_live: boolean;
  chapters: VideoChapter[];
  language?: string;
  approx_bytes?: number;
  manual_sub_langs: string[];
  auto_sub_langs: string[];
}

function subtitleLangs(value: unknown): string[] {
  if (!isRecord(value)) return [];
  return Object.keys(value)
    .filter((lang) => lang !== 'live_chat')
    .sort();
}

function parseChapters(raw: unknown, durationSec: number): VideoChapter[] {
  if (!Array.isArray(raw)) return [];
  const chapters: VideoChapter[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const start = numberOf(entry.start_time);
    if (start === undefined) continue;
    const tags = isRecord(entry.tags) ? entry.tags : {};
    chapters.push({
      start_sec: start,
      end_sec: numberOf(entry.end_time) ?? durationSec,
      title: textOf(entry.title) ?? textOf(tags.title) ?? `Chapter ${chapters.length + 1}`,
    });
  }
  return chapters.sort((a, b) => a.start_sec - b.start_sec);
}

function formatBytes(format: Record<string, unknown>): number | undefined {
  return numberOf(format.filesize) ?? numberOf(format.filesize_approx);
}

/** Sum of a merged selection's streams; undefined unless every stream reports a size. */
function requestedFormatsBytes(raw: unknown): number | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  let total = 0;
  for (const entry of raw) {
    const bytes = isRecord(entry) ? formatBytes(entry) : undefined;
    if (bytes === undefined) return undefined;
    total += bytes;
  }
  return total;
}

export function parseYtDlpInfo(stdout: string): RemoteVideoInfo {
  const info = parseSafeJsonInput(stdout, 'yt-dlp info');
  if (!isRecord(info)) throw new VideoIngestError('TOOL_FAILED', 'yt-dlp info is not an object');
  const rawDuration = numberOf(info.duration);
  const duration = rawDuration ?? 0;
  const liveStatus = textOf(info.live_status);
  const approxBytes = formatBytes(info) ?? requestedFormatsBytes(info.requested_formats);
  return {
    metadata: {
      title: textOf(info.title) ?? 'untitled',
      duration_sec: duration,
      ...(textOf(info.uploader) ? { uploader: textOf(info.uploader) } : {}),
      ...(textOf(info.license) ? { license: textOf(info.license) } : {}),
    },
    duration_known: rawDuration !== undefined && rawDuration > 0,
    is_live:
      info.is_live === true ||
      liveStatus === 'is_live' ||
      liveStatus === 'is_upcoming' ||
      liveStatus === 'post_live',
    chapters: parseChapters(info.chapters, duration),
    ...(textOf(info.language) ? { language: textOf(info.language) } : {}),
    ...(approxBytes ? { approx_bytes: approxBytes } : {}),
    manual_sub_langs: subtitleLangs(info.subtitles),
    auto_sub_langs: subtitleLangs(info.automatic_captions),
  };
}

function primarySubtag(lang: string): string {
  return lang.toLowerCase().split(/[-_]/)[0] ?? '';
}

function matchLang(available: string[], wanted: string, preferOrig: boolean): string | null {
  const lower = wanted.toLowerCase();
  const exact = available.find((lang) => lang.toLowerCase() === lower);
  const orig = available.find((lang) => lang.toLowerCase() === `${lower}-orig`);
  const primary = available.find((lang) => primarySubtag(lang) === primarySubtag(wanted));
  return (preferOrig ? (orig ?? exact) : (exact ?? orig)) ?? primary ?? null;
}

export interface SubtitleChoice {
  origin: Exclude<VideoTranscriptOrigin, 'stt'>;
  lang: string;
}

/** Manual subtitles beat automatic captions for the wanted language. */
export function chooseSubtitleTrack(info: RemoteVideoInfo, wanted: string): SubtitleChoice | null {
  const manual = matchLang(info.manual_sub_langs, wanted, false);
  if (manual) return { origin: 'manual_subs', lang: manual };
  const auto = matchLang(info.auto_sub_langs, wanted, true);
  if (auto) return { origin: 'auto_subs', lang: auto };
  return null;
}

const YT_DLP_BASE_ARGS = ['--ignore-config', '--no-update', '--no-playlist', '--no-warnings'];

/** Probe with the same `-f` selector the download uses so size checks match the selection. */
export async function fetchRemoteVideoInfo(
  runner: VideoCommandRunner,
  ytDlpBin: string,
  url: string,
  format?: string
): Promise<RemoteVideoInfo> {
  const args = [...YT_DLP_BASE_ARGS, ...(format ? ['-f', format] : []), '-J', url];
  const result = await runVideoTool(runner, 'yt-dlp', ytDlpBin, args, {
    timeoutMs: 120_000,
    maxOutputMB: 50,
  });
  return parseYtDlpInfo(result.stdout);
}

export interface RemoteDownload {
  media_path: string;
  subtitle_path?: string;
}

const NON_MEDIA_EXTENSIONS = new Set(['vtt', 'part', 'json', 'ytdl', 'tmp', 'temp']);

/** Final (merged) output: exactly `source.<ext>`; split streams are `source.f<id>.<ext>`. */
function isFinalMediaFile(name: string): boolean {
  const match = /^source\.([A-Za-z0-9]+)$/.exec(name);
  return Boolean(match && !NON_MEDIA_EXTENSIONS.has(match[1].toLowerCase()));
}

function isSplitStreamFile(name: string): boolean {
  return /^source\.f[A-Za-z0-9-]+\.[A-Za-z0-9]+$/.test(name);
}

function isSourceMediaArtifact(name: string): boolean {
  return name.startsWith('source.') && !name.endsWith('.vtt');
}

/** Remove downloaded source media (final, split, partial) from a cache entry; subtitles stay. */
export function removeSourceMedia(workDir: string): string[] {
  if (!safeExistsSync(workDir)) return [];
  const removed = safeReaddir(workDir).filter(isSourceMediaArtifact).sort();
  for (const name of removed) safeRmSync(path.join(workDir, name), { force: true });
  return removed;
}

/**
 * Download into `workDir` as `source.<ext>`. Any failure (tool error, size
 * limit, missing or only split output) removes the partial media from the
 * cache entry before the error propagates.
 */
export async function downloadRemoteVideo(
  runner: VideoCommandRunner,
  ytDlpBin: string,
  url: string,
  workDir: string,
  options: {
    format: string;
    maxBytes: number;
    subtitle?: SubtitleChoice | null;
    ffmpegBin?: string;
  }
): Promise<RemoteDownload> {
  try {
    return await downloadRemoteVideoUnchecked(runner, ytDlpBin, url, workDir, options);
  } catch (error) {
    removeSourceMedia(workDir);
    throw error;
  }
}

async function downloadRemoteVideoUnchecked(
  runner: VideoCommandRunner,
  ytDlpBin: string,
  url: string,
  workDir: string,
  options: {
    format: string;
    maxBytes: number;
    subtitle?: SubtitleChoice | null;
    ffmpegBin?: string;
  }
): Promise<RemoteDownload> {
  // -P keeps the (possibly '%'-containing) cache path out of the output template.
  const args = [
    ...YT_DLP_BASE_ARGS,
    '--no-progress',
    '--match-filter',
    '!is_live',
    ...(options.ffmpegBin ? ['--ffmpeg-location', options.ffmpegBin] : []),
    '-f',
    options.format,
    '--max-filesize',
    String(options.maxBytes),
    '-P',
    workDir,
    '-o',
    'source.%(ext)s',
  ];
  if (options.subtitle) {
    args.push(
      options.subtitle.origin === 'manual_subs' ? '--write-subs' : '--write-auto-subs',
      '--sub-format',
      'vtt',
      '--sub-langs',
      options.subtitle.lang
    );
  }
  args.push(url);
  const result = await runVideoTool(runner, 'yt-dlp', ytDlpBin, args, {
    timeoutMs: 30 * 60_000,
    maxOutputMB: 20,
  });
  const names = safeExistsSync(workDir) ? safeReaddir(workDir).sort() : [];
  const media = names.find(isFinalMediaFile);
  if (!media) {
    const output = `${result.stdout}\n${result.stderr}`;
    if (output.includes('max-filesize')) {
      throw new VideoIngestError(
        'SIZE_EXCEEDED',
        `remote video exceeds max_bytes ${options.maxBytes}`
      );
    }
    if (names.some(isSplitStreamFile)) {
      throw new VideoIngestError(
        'TOOL_FAILED',
        'yt-dlp left only split audio/video streams (merge failed; check --ffmpeg-location)'
      );
    }
    throw new VideoIngestError('TOOL_FAILED', 'yt-dlp finished without producing a media file');
  }
  const mediaPath = path.join(workDir, media);
  if (safeStat(mediaPath).size > options.maxBytes) {
    throw new VideoIngestError(
      'SIZE_EXCEEDED',
      `remote video exceeds max_bytes ${options.maxBytes}`
    );
  }
  const subtitleName = options.subtitle ? `source.${options.subtitle.lang}.vtt` : undefined;
  return {
    media_path: mediaPath,
    ...(subtitleName && names.includes(subtitleName)
      ? { subtitle_path: path.join(workDir, subtitleName) }
      : {}),
  };
}

export interface LocalVideoInfo {
  metadata: VideoMetadata;
  chapters: VideoChapter[];
}

export async function probeLocalVideo(
  runner: VideoCommandRunner,
  ffprobeBin: string,
  filePath: string
): Promise<LocalVideoInfo> {
  const result = await runVideoTool(
    runner,
    'ffprobe',
    ffprobeBin,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_chapters', filePath],
    { timeoutMs: 60_000, maxOutputMB: 10 }
  );
  const probe = parseSafeJsonInput(result.stdout, 'ffprobe output');
  const format = isRecord(probe) && isRecord(probe.format) ? probe.format : {};
  const tags = isRecord(format.tags) ? format.tags : {};
  const duration = numberOf(format.duration) ?? 0;
  return {
    metadata: {
      title: textOf(tags.title) ?? path.basename(filePath),
      duration_sec: duration,
      ...(textOf(tags.artist) ? { uploader: textOf(tags.artist) } : {}),
      ...(textOf(tags.copyright) ? { license: textOf(tags.copyright) } : {}),
    },
    chapters: parseChapters(isRecord(probe) ? probe.chapters : undefined, duration),
  };
}
