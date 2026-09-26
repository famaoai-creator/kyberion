import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { defineCatalog } from '../foundation/governed-catalog.js';
import { parseSafeJsonInput } from '../foundation/safe-json.js';
import { isRecord } from '../foundation/text.js';
import * as pathResolver from '../path-resolver.js';
import {
  safeExecResultAsync,
  safeExistsSync,
  safeReadFile,
  safeReaddir,
  safeStat,
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

export function fileContentKey(filePath: string, maxBytes: number): string {
  assertLocalVideoWithinLimits(filePath, maxBytes);
  const data = safeReadFile(filePath, {
    encoding: null,
    maxSizeMB: Math.ceil(maxBytes / (1024 * 1024)),
  }) as Buffer;
  return sha256Hex(data);
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

export function parseYtDlpInfo(stdout: string): RemoteVideoInfo {
  const info = parseSafeJsonInput(stdout, 'yt-dlp info');
  if (!isRecord(info)) throw new VideoIngestError('TOOL_FAILED', 'yt-dlp info is not an object');
  const duration = numberOf(info.duration) ?? 0;
  return {
    metadata: {
      title: textOf(info.title) ?? 'untitled',
      duration_sec: duration,
      ...(textOf(info.uploader) ? { uploader: textOf(info.uploader) } : {}),
      ...(textOf(info.license) ? { license: textOf(info.license) } : {}),
    },
    chapters: parseChapters(info.chapters, duration),
    ...(textOf(info.language) ? { language: textOf(info.language) } : {}),
    ...((numberOf(info.filesize) ?? numberOf(info.filesize_approx))
      ? { approx_bytes: numberOf(info.filesize) ?? numberOf(info.filesize_approx) }
      : {}),
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

export async function fetchRemoteVideoInfo(
  runner: VideoCommandRunner,
  ytDlpBin: string,
  url: string
): Promise<RemoteVideoInfo> {
  const result = await runVideoTool(runner, 'yt-dlp', ytDlpBin, [...YT_DLP_BASE_ARGS, '-J', url], {
    timeoutMs: 120_000,
    maxOutputMB: 50,
  });
  return parseYtDlpInfo(result.stdout);
}

export interface RemoteDownload {
  media_path: string;
  subtitle_path?: string;
}

function isMediaFile(name: string): boolean {
  if (!name.startsWith('source.')) return false;
  return !['.vtt', '.part', '.json', '.ytdl', '.tmp'].some((ext) => name.endsWith(ext));
}

export async function downloadRemoteVideo(
  runner: VideoCommandRunner,
  ytDlpBin: string,
  url: string,
  workDir: string,
  options: { format: string; maxBytes: number; subtitle?: SubtitleChoice | null }
): Promise<RemoteDownload> {
  const args = [
    ...YT_DLP_BASE_ARGS,
    '--no-progress',
    '-f',
    options.format,
    '--max-filesize',
    String(options.maxBytes),
    '-o',
    path.join(workDir, 'source.%(ext)s'),
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
  const media = names.find(isMediaFile);
  if (!media) {
    const output = `${result.stdout}\n${result.stderr}`;
    if (output.includes('max-filesize')) {
      throw new VideoIngestError(
        'SIZE_EXCEEDED',
        `remote video exceeds max_bytes ${options.maxBytes}`
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
