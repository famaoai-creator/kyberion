import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  assertSafeRepositoryPath,
  buildSafeExecEnv,
  safeCopyFileSync,
  safeExecResultAsync,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeReaddir,
  safeRealpath,
  safeStat,
  safeWriteFile,
} from '../secure-io.js';
import { pathResolver } from '../path-resolver.js';
import {
  createScratchWorkspace,
  listWorkspaces,
  workspacesRootDir,
} from '../workforce/workspace-ledger.js';
import { resolveFfprobeBin } from '../tool/tool-binary-resolvers.js';
import { resolveVideoBackend } from '../media/media-backend-registry.js';
import { getRegisteredEnvText } from '../foundation/env.js';
import { getVideoRenderRuntimePolicy } from './video-render-runtime-policy.js';
import { parseVtt } from './ingest/vtt-parser.js';
import type { TranscriptSegment } from './ingest/video-ingest-types.js';
import { renderSceneTimelineRuntime } from './video-timeline-runtime.js';
import {
  buildVideoDesignCssVars,
  resolveDefaultVideoBackgroundColor,
} from './video-design-system.js';

/** First version accepts only public, local shared scratch assets; it never fetches media. */
export interface VideoRecutRequest {
  source_path: string;
  subtitles_path: string;
  bundle_dir?: string;
  window?: { start_sec: number; end_sec: number };
  padding?: { before_sec: number; after_sec: number };
  gap_threshold_sec?: number;
  attribution?: { title: string; lines: string[]; duration_sec?: number };
}

export interface VideoRecutClip {
  id: string;
  source_start: number;
  source_end: number;
  output_start: number;
  duration: number;
}
export interface VideoRecutCaption extends VideoRecutClip {
  text: string;
}
export interface VideoRecutPlan {
  version: 1;
  source_duration: number;
  selected_window: { start_sec: number; end_sec: number };
  excluded_cue_count: number;
  clips: VideoRecutClip[];
  captions: VideoRecutCaption[];
  edited_duration: number;
  duration_sec: number;
}
export interface PreparedVideoRecut {
  bundle_dir: string;
  index_html: string;
  source_map_path: string;
  duration_sec: number;
  fps: number;
  width: number;
  height: number;
  plan: VideoRecutPlan;
}

const FPS = 30;
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const round = (n: number): number => {
  const result = Math.round(n * 1e9) / 1e9;
  if (!finite(result)) throw new Error('Recut timing exceeds numeric precision');
  return result;
};
const escapeHtml = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  );

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new Error('Invalid recut object or unknown field');
  return value as Record<string, unknown>;
}
function localPath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value !== value.trim() ||
    /[\x00-\x1f]/u.test(value) ||
    (path.sep !== '\\' && value.includes('\\')) ||
    (/^[a-z][a-z\d+.-]*:/iu.test(value) && !path.isAbsolute(value)) ||
    value.startsWith('//') ||
    value.startsWith('\\\\')
  )
    throw new Error('Expected local scratch path');
  const absolute = path.resolve(pathResolver.rootDir(), value);
  const root = path.resolve(pathResolver.sharedTmp());
  if (!absolute.startsWith(root + path.sep))
    throw new Error('Recut paths must stay under shared scratch');
  return value;
}
function nonnegative(n: unknown): n is number {
  return finite(n) && n >= 0;
}

export function parseVideoRecutRequest(value: unknown): VideoRecutRequest {
  const o = object(value, [
    'source_path',
    'subtitles_path',
    'bundle_dir',
    'window',
    'padding',
    'gap_threshold_sec',
    'attribution',
  ]);
  localPath(o.source_path);
  localPath(o.subtitles_path);
  if (o.bundle_dir !== undefined) localPath(o.bundle_dir);
  if (o.window !== undefined) {
    const w = object(o.window, ['start_sec', 'end_sec']);
    if (!nonnegative(w.start_sec) || !finite(w.end_sec) || w.end_sec <= w.start_sec)
      throw new Error('Invalid recut window');
  }
  if (o.padding !== undefined) {
    const p = object(o.padding, ['before_sec', 'after_sec']);
    if (!nonnegative(p.before_sec) || !nonnegative(p.after_sec))
      throw new Error('Invalid recut padding');
  }
  const padding = o.padding as VideoRecutRequest['padding'];
  const gap = o.gap_threshold_sec ?? 1;
  if (!nonnegative(gap) || gap < (padding?.before_sec ?? 0.15) + (padding?.after_sec ?? 0.2))
    throw new Error('Invalid recut gap threshold');
  if (o.attribution !== undefined) {
    const a = object(o.attribution, ['title', 'lines', 'duration_sec']);
    if (
      typeof a.title !== 'string' ||
      !a.title.trim() ||
      a.title.length > 512 ||
      !Array.isArray(a.lines) ||
      a.lines.length > 20 ||
      !a.lines.every((line) => typeof line === 'string' && line.trim() && line.length <= 2048) ||
      (a.duration_sec !== undefined &&
        (!finite(a.duration_sec) || a.duration_sec <= 0 || a.duration_sec > 120))
    )
      throw new Error('Invalid attribution');
  }
  return structuredClone(o) as unknown as VideoRecutRequest;
}

/** Cut long gaps between complete supplied cues. This does not infer speech or mistakes. */
export function planVideoRecut(
  input: VideoRecutRequest,
  cues: TranscriptSegment[],
  sourceDuration: number
): VideoRecutPlan {
  const request = parseVideoRecutRequest(input);
  if (!finite(sourceDuration) || sourceDuration <= 0 || sourceDuration > 86400)
    throw new Error('Invalid source duration (maximum 24 hours)');
  if (!Array.isArray(cues) || cues.length > 10000)
    throw new Error('Recut supports at most 10000 cues');
  const window = request.window ?? { start_sec: 0, end_sec: sourceDuration };
  if (window.end_sec > sourceDuration) throw new Error('Window outside source');
  const before = request.padding?.before_sec ?? 0.15;
  const after = request.padding?.after_sec ?? 0.2;
  const selected: TranscriptSegment[] = [];
  let previousEnd = 0;
  for (const cue of cues) {
    if (
      !nonnegative(cue.start_sec) ||
      !finite(cue.end_sec) ||
      cue.start_sec < previousEnd ||
      cue.end_sec <= cue.start_sec ||
      cue.end_sec > sourceDuration ||
      typeof cue.text !== 'string' ||
      !cue.text.trim()
    )
      throw new Error('Invalid, overlapping or outside-source subtitle cue');
    previousEnd = cue.end_sec;
    if (cue.end_sec <= window.start_sec || cue.start_sec >= window.end_sec) continue;
    if (cue.start_sec < window.start_sec || cue.end_sec > window.end_sec)
      throw new Error('Subtitle cue crosses window boundary');
    selected.push(cue);
  }
  if (!selected.length) throw new Error('No complete subtitle cues in window');
  const groups: Array<{ start: number; end: number; speechEnd: number }> = [];
  for (const cue of selected) {
    const last = groups.at(-1);
    if (last && cue.start_sec - last.speechEnd <= (request.gap_threshold_sec ?? 1)) {
      last.end = Math.min(window.end_sec, cue.end_sec + after);
      last.speechEnd = cue.end_sec;
    } else
      groups.push({
        start: Math.max(window.start_sec, cue.start_sec - before),
        end: Math.min(window.end_sec, cue.end_sec + after),
        speechEnd: cue.end_sec,
      });
  }
  let cursor = 0;
  const clips = groups.map((g, i) => {
    const clip = {
      id: `shot-${i + 1}`,
      source_start: g.start,
      source_end: g.end,
      output_start: cursor,
      duration: round(g.end - g.start),
    };
    if (clip.duration <= 0) throw new Error('Recut clip is below timing precision');
    // HyperFrames checks adjacent audio intervals using exact numeric addition.
    // A separately rounded cursor can create a microscopic overlap and duplicate audio.
    cursor += clip.duration;
    return clip;
  });
  const captions = selected.map((cue, i) => {
    const clip = clips.find((c) => cue.start_sec >= c.source_start && cue.end_sec <= c.source_end);
    if (!clip) throw new Error('Subtitle crosses cut boundary');
    return {
      id: `caption-${i + 1}`,
      text: cue.text,
      source_start: cue.start_sec,
      source_end: cue.end_sec,
      output_start: round(clip.output_start + cue.start_sec - clip.source_start),
      duration: round(cue.end_sec - cue.start_sec),
    };
  });
  // Pad only the end to a full output frame; preserve every source/caption offset.
  const duration =
    Math.ceil(
      round(cursor + (request.attribution ? (request.attribution.duration_sec ?? 4) : 0)) * FPS
    ) / FPS;
  if (!finite(duration) || duration <= 0) throw new Error('Invalid planned duration');
  return {
    version: 1,
    source_duration: sourceDuration,
    selected_window: window,
    excluded_cue_count: cues.length - selected.length,
    clips,
    captions,
    edited_duration: cursor,
    duration_sec: duration,
  };
}

function scratchPath(value: string): string {
  localPath(value);
  const root = safeRealpath(pathResolver.sharedTmp());
  const resolved = safeRealpath(
    assertSafeRepositoryPath(path.resolve(pathResolver.rootDir(), value), {
      allowMissingLeaf: true,
    })
  );
  if (!resolved.startsWith(root + path.sep)) throw new Error('Scratch symlink escape');
  return resolved;
}

function preparedBundlePath(value: string): string {
  const absolute = path.resolve(pathResolver.rootDir(), value);
  if (absolute.startsWith(path.resolve(pathResolver.sharedTmp()) + path.sep))
    return scratchPath(value);
  const resolved = safeRealpath(assertSafeRepositoryPath(absolute));
  const workspaceRoot = safeRealpath(workspacesRootDir());
  if (
    resolved !== absolute ||
    path.dirname(resolved) !== workspaceRoot ||
    !listWorkspaces().some(
      (record) =>
        record.path === resolved &&
        record.kind === 'scratch-dir' &&
        record.live &&
        record.owner.session_id?.startsWith('video-recut-')
    )
  )
    throw new Error('Invalid registered recut workspace');
  return resolved;
}

function bundleArtifact(bundle: string, value: string, basename: string): string {
  const candidate = path.resolve(value);
  const expected = path.join(bundle, basename);
  if (
    candidate !== expected ||
    safeRealpath(assertSafeRepositoryPath(candidate, { allowMissingLeaf: true })) !== expected
  )
    throw new Error('Bundle artifact escape');
  return expected;
}

async function probe(
  file: string
): Promise<{ duration: number; width: number; height: number; fps: number }> {
  const result = await safeExecResultAsync(
    resolveFfprobeBin(),
    ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file],
    { timeoutMs: 30_000 }
  );
  if (result.status !== 0) throw new Error('Media probe failed');
  const meta = JSON.parse(result.stdout);
  const video = meta.streams?.find((s: { codec_type: string }) => s.codec_type === 'video');
  const audio = meta.streams?.find((s: { codec_type: string }) => s.codec_type === 'audio');
  const duration = Number(meta.format?.duration);
  if (
    !video ||
    !audio ||
    !finite(duration) ||
    duration <= 0 ||
    !Number.isInteger(video.width) ||
    !Number.isInteger(video.height) ||
    video.width <= 0 ||
    video.height <= 0
  )
    throw new Error('Recut requires valid video and original audio streams');
  const [numerator, denominator = '1'] = String(
    video.avg_frame_rate ?? video.r_frame_rate ?? ''
  ).split('/');
  const fps = Number(numerator) / Number(denominator);
  return { duration, width: video.width, height: video.height, fps };
}

function designVars(): Record<string, string> {
  return buildVideoDesignCssVars({
    backgroundColor: resolveDefaultVideoBackgroundColor(),
    layoutFamily: 'process-flow',
    motionProfile: 'guided-step',
    designSystemRef: { system_id: 'default' },
  });
}
function creditMarkup(
  attribution: NonNullable<VideoRecutRequest['attribution']>,
  duration: number,
  width: number,
  height: number
): string {
  const cssVars = Object.entries(designVars())
    .map(([key, value]) => `${key}:${value}`)
    .join(';');
  return `<template><div id="root" data-composition-id="recut-credits" data-width="${width}" data-height="${height}" data-duration="${duration}"><style>#root{${cssVars};position:relative;width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;background:var(--kb-bg-main);color:var(--kb-accent-text);font-family:system-ui,sans-serif;text-align:center;padding:8%;box-sizing:border-box;font-size:clamp(18px,3vw,60px);overflow-wrap:anywhere}h1{font-size:1.35em}</style><h1>${escapeHtml(attribution.title)}</h1>${attribution.lines.map((line) => `<p>${escapeHtml(line)}</p>`).join('')}${renderSceneTimelineRuntime({ sceneKey: 'recut-credits', durationSec: duration })}</div></template>`;
}
function markup(
  request: VideoRecutRequest,
  plan: VideoRecutPlan,
  width: number,
  height: number,
  media: string
): string {
  const vars = designVars();
  const videos = plan.clips
    .map(
      (c) =>
        `<video id="${c.id}" class="clip footage" src="${escapeHtml(media)}" data-start="${c.output_start}" data-duration="${c.duration}" data-media-start="${c.source_start}" data-track-index="0" data-has-audio="true" playsinline></video>`
    )
    .join('');
  const captions = plan.captions
    .map(
      (c) =>
        `<div id="${c.id}" class="clip caption" data-start="${c.output_start}" data-duration="${c.duration}" data-track-index="1"><span>${escapeHtml(c.text)}</span></div>`
    )
    .join('');
  const credits = request.attribution
    ? `<div id="recut-credits" class="clip" data-composition-id="recut-credits" data-composition-src="compositions/credits.html" data-start="${plan.edited_duration}" data-duration="${plan.duration_sec - plan.edited_duration}" data-track-index="2"></div>`
    : '';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=${width}, height=${height}"><title>${escapeHtml(request.attribution?.title ?? 'Video recut')}</title><style>.credits{flex-direction:column}:root{${Object.entries(
    vars
  )
    .map(([k, v]) => `${k}:${v}`)
    .join(
      ';'
    )}}*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;background:var(--kb-bg-main);font-family:system-ui,sans-serif;color:var(--kb-accent-text)}#root{position:relative;width:100%;height:100%;overflow:hidden}.clip{position:absolute;inset:0}.footage{width:100%;height:100%;object-fit:contain}.caption{inset:auto 4% 5%;display:flex;justify-content:center;z-index:2}.caption span{background:var(--kb-bg-ink);padding:.35em .65em;font-size:clamp(18px,3vw,60px);line-height:1.35;text-align:center;white-space:pre-wrap;overflow-wrap:anywhere}.credits{display:flex;align-items:center;justify-content:center;background:var(--kb-bg-main);z-index:3;text-align:center;padding:8%;font-size:clamp(18px,3vw,60px);overflow-wrap:anywhere}h1{font-size:1.35em}</style></head><body><div id="root" data-composition-id="recut" data-width="${width}" data-height="${height}" data-duration="${plan.duration_sec}">${videos}${captions}${credits}</div>${renderSceneTimelineRuntime({ sceneKey: 'recut', durationSec: plan.duration_sec })}</body></html>`;
}

export async function prepareVideoRecut(input: VideoRecutRequest): Promise<PreparedVideoRecut> {
  const request = parseVideoRecutRequest(input);
  const source = scratchPath(request.source_path);
  const subtitles = scratchPath(request.subtitles_path);
  const extension = path.extname(source).toLowerCase();
  if (!['.mp4', '.mov', '.webm', '.mkv', '.m4v'].includes(extension))
    throw new Error('Unsupported source container');
  if (!safeStat(source).isFile() || !safeStat(subtitles).isFile() || source === subtitles)
    throw new Error('Invalid or aliased inputs');
  if (safeStat(subtitles).size > 16 * 1024 * 1024) throw new Error('Subtitle file exceeds 16 MiB');
  const metadata = await probe(source);
  const subtitleText = String(safeReadFile(subtitles, { encoding: 'utf8' }));
  const cues = parseVtt(subtitleText);
  // The canonical parser skips malformed blocks; reject them instead of silently dropping edits.
  const timingSeparatorCount = subtitleText.split('-->').length - 1;
  if (timingSeparatorCount !== cues.length) throw new Error('Malformed or empty subtitle cue');
  const plan = planVideoRecut(request, cues, metadata.duration);
  const bundle = request.bundle_dir
    ? scratchPath(request.bundle_dir)
    : preparedBundlePath(
        createScratchWorkspace({ session_id: `video-recut-${randomUUID()}` }).path
      );
  if (
    source.startsWith(bundle + path.sep) ||
    subtitles.startsWith(bundle + path.sep) ||
    bundle === source ||
    bundle === subtitles
  )
    throw new Error('Input/output alias');
  if (safeExistsSync(bundle) && (!safeStat(bundle).isDirectory() || safeReaddir(bundle).length))
    throw new Error('Refusing to overwrite nonempty bundle');
  safeMkdir(bundle, { recursive: true });
  const media = `source${extension}`;
  safeCopyFileSync(source, path.join(bundle, media));
  const index = path.join(bundle, 'index.html');
  const map = path.join(bundle, 'source-map.json');
  if (request.attribution) {
    safeMkdir(path.join(bundle, 'compositions'), { recursive: true });
    safeWriteFile(
      path.join(bundle, 'compositions/credits.html'),
      creditMarkup(
        request.attribution,
        plan.duration_sec - plan.edited_duration,
        metadata.width,
        metadata.height
      )
    );
  }
  safeWriteFile(map, JSON.stringify(plan, null, 2) + '\n');
  safeWriteFile(index, markup(request, plan, metadata.width, metadata.height, media));
  return {
    bundle_dir: bundle,
    index_html: index,
    source_map_path: map,
    duration_sec: plan.duration_sec,
    fps: FPS,
    width: metadata.width,
    height: metadata.height,
    plan,
  };
}

/** Exact registered renderer only: failures are errors, never a still-image substitute. */
export async function renderVideoRecut(
  prepared: PreparedVideoRecut
): Promise<{ output_path: string }> {
  const policy = getVideoRenderRuntimePolicy();
  if (!policy.render.enable_backend_rendering || policy.render.backend === 'none')
    throw new Error('Recut rendering disabled by policy');
  if (!policy.render.allowed_output_formats.includes('mp4'))
    throw new Error('MP4 rendering disabled by policy');
  const backend = resolveVideoBackend(policy.render.backend);
  if (
    backend.provider !== 'hyperframes' ||
    backend.status !== 'active' ||
    !backend.command ||
    !backend.args ||
    !backend.video_render?.argument_template ||
    !backend.supports?.artifact_formats?.includes('mp4')
  )
    throw new Error('Recut requires an active registered HyperFrames renderer');
  const bundle = preparedBundlePath(prepared.bundle_dir);
  if (
    bundleArtifact(bundle, prepared.index_html, 'index.html') !== path.join(bundle, 'index.html') ||
    !safeStat(prepared.index_html).isFile()
  )
    throw new Error('Invalid prepared bundle');
  if (
    !finite(prepared.duration_sec) ||
    prepared.duration_sec <= 0 ||
    prepared.fps !== FPS ||
    !Number.isInteger(prepared.width) ||
    !Number.isInteger(prepared.height) ||
    prepared.width <= 0 ||
    prepared.height <= 0
  )
    throw new Error('Invalid prepared render metadata');
  const output = bundleArtifact(bundle, path.join(bundle, 'output.mp4'), 'output.mp4');
  if (safeExistsSync(output)) throw new Error('Refusing to overwrite render output');
  const values: Record<string, string> = {
    bundle_dir: bundle,
    output_path: output,
    output_format: 'mp4',
    fps: String(prepared.fps),
    quality: policy.render.quality,
    duration_sec: String(prepared.duration_sec),
    width: String(prepared.width),
    height: String(prepared.height),
  };
  const args = [...backend.args, ...backend.video_render.argument_template].map((part) =>
    part.replace(/\{([a-z_]+)\}/gu, (_match, key: string) => {
      if (!(key in values)) throw new Error('Unknown recut render placeholder');
      return values[key];
    })
  );
  const preload = backend.video_render.preload_script
    ? assertSafeRepositoryPath(pathResolver.rootResolve(backend.video_render.preload_script))
    : undefined;
  const options = getRegisteredEnvText('NODE_OPTIONS');
  const result = await safeExecResultAsync(backend.command, args, {
    timeoutMs: policy.render.command_timeout_ms,
    cwd: pathResolver.rootDir(),
    env: buildSafeExecEnv(
      preload ? { NODE_OPTIONS: `${options ? options + ' ' : ''}--require=${preload}` } : {}
    ),
  });
  if (result.status !== 0) throw new Error('Recut renderer failed; no fallback was attempted');
  const actual = await probe(output);
  if (
    Math.abs(actual.duration - prepared.duration_sec) > 2 / prepared.fps ||
    actual.width !== prepared.width ||
    actual.height !== prepared.height ||
    !finite(actual.fps) ||
    Math.abs(actual.fps - prepared.fps) > 0.01
  )
    throw new Error('Recut output duration, dimensions or fps mismatch');
  return { output_path: output };
}
