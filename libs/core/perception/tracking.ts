import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createLogger } from '../logger.js';
import { spawnManagedProcess, stopManagedProcess } from '../managed-process.js';
import {
  observation,
  resolvePerceptionScope,
  type PerceptionSource,
  type Observation,
} from './observation.js';
import { pathResolver } from '../path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeLstat,
  safeReadFileRange,
  safeExecResultAsync,
  assertGovernedExec,
  buildSafeExecEnv,
} from '../secure-io.js';
import { isRecord } from '../foundation/text.js';
import { parseSafeJsonInput } from '../foundation/safe-json.js';
import type { AnimationCue } from '../realtime-media-session.js';

const logger = createLogger('perception-tracking');

export interface TrackingLandmark {
  x: number;
  y: number;
  z: number;
  visibility?: number;
}
export interface TrackingFace {
  landmarks: TrackingLandmark[];
  blendshapes: Record<string, number>;
  transform?: number[];
}
export interface TrackingPose {
  landmarks: TrackingLandmark[];
}
export interface TrackingGesture {
  label: string;
  confidence: number;
  handedness?: string;
  landmarks: TrackingLandmark[];
}
export interface TrackingFrame {
  time_sec: number;
  faces: TrackingFace[];
  poses: TrackingPose[];
  gestures: TrackingGesture[];
}
export interface TrackingResult {
  provider: 'mediapipe-local';
  frames: TrackingFrame[];
  warnings: string[];
}
export interface TrackMediaRequest {
  path: string;
  faceModel?: string;
  poseModel?: string;
  gestureModel?: string;
  python?: string;
  maxFrames?: number;
  everyMs?: number;
  timeoutMs?: number;
}
export type TrackingRunner = typeof safeExecResultAsync;
export const MAX_TRACKING_FRAMES = 300;
const MAX_JSON_BYTES = 12 * 1024 * 1024;
const fail = (message: string): never => {
  throw new Error('[TRACKING_INVALID] ' + message);
};
function finite(value: unknown, label: string, minimum = -100, maximum = 100): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum)
    fail(label + ' must be a finite number in range');
  return value as number;
}
function array(value: unknown, label: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail(label + ' must be a bounded array');
  return value as unknown[];
}
function landmarks(value: unknown, max: number): TrackingLandmark[] {
  return array(value, 'landmarks', max).map((point) => {
    if (!isRecord(point)) fail('landmark must be an object');
    const p = point as Record<string, unknown>;
    return {
      x: finite(p.x, 'x'),
      y: finite(p.y, 'y'),
      z: finite(p.z, 'z'),
      ...(p.visibility !== undefined
        ? { visibility: finite(p.visibility, 'visibility', 0, 1) }
        : {}),
    };
  });
}
function smallText(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 128 ||
    /[\u0000-\u001f]/u.test(value)
  )
    fail(label + ' must be bounded text');
  return value as string;
}
/** Treat helper stdout as untrusted: finite coordinates, bounded arrays and strictly increasing source timestamps. */
export function parseTrackingResult(
  value: unknown,
  maxFrames = MAX_TRACKING_FRAMES
): TrackingResult {
  if (!Number.isInteger(maxFrames) || maxFrames < 1 || maxFrames > MAX_TRACKING_FRAMES)
    fail('maxFrames out of range');
  if (!isRecord(value) || value.provider !== 'mediapipe-local') fail('unknown tracking provider');
  const data = value as Record<string, unknown>;
  let previous = -1;
  const frames = array(data.frames, 'frames', maxFrames).map((entry): TrackingFrame => {
    if (!isRecord(entry)) fail('frame must be an object');
    const f = entry as Record<string, unknown>;
    const time = finite(f.time_sec, 'time_sec', 0, 86400);
    if (time <= previous) fail('frame times must be strictly increasing');
    previous = time;
    return {
      time_sec: time,
      faces: array(f.faces, 'faces', 4).map((entry): TrackingFace => {
        if (!isRecord(entry) || !isRecord(entry.blendshapes)) fail('face must contain blendshapes');
        const face = entry as Record<string, unknown>;
        const entries = Object.entries(face.blendshapes as Record<string, unknown>);
        if (entries.length > 64) fail('too many blendshapes');
        const shapes: Record<string, number> = {};
        for (const [name, score] of entries) {
          if (
            !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u.test(name) ||
            ['constructor', 'prototype', '__proto__'].includes(name)
          )
            fail('invalid blendshape name');
          shapes[name] = finite(score, 'blendshape score', 0, 1);
        }
        const transform =
          face.transform === undefined
            ? undefined
            : array(face.transform, 'transform', 16).map((v) =>
                finite(v, 'transform', -1000000, 1000000)
              );
        if (transform && transform.length !== 16) fail('transform must be a 4x4 matrix');
        return {
          landmarks: landmarks(face.landmarks, 478),
          blendshapes: shapes,
          ...(transform ? { transform } : {}),
        };
      }),
      poses: array(f.poses ?? [], 'poses', 4).map((entry) => {
        if (!isRecord(entry)) fail('pose must be an object');
        return { landmarks: landmarks((entry as Record<string, unknown>).landmarks, 33) };
      }),
      gestures: array(f.gestures ?? [], 'gestures', 8).map((entry) => {
        if (!isRecord(entry)) fail('gesture must be an object');
        const g = entry as Record<string, unknown>;
        return {
          label: smallText(g.label, 'gesture label'),
          confidence: finite(g.confidence, 'gesture confidence', 0, 1),
          landmarks: landmarks(g.landmarks, 21),
          ...(g.handedness !== undefined
            ? { handedness: smallText(g.handedness, 'handedness') }
            : {}),
        };
      }),
    };
  });
  const warnings = array(data.warnings ?? [], 'warnings', 10).map((v) => {
    if (typeof v !== 'string' || v.length > 1024) fail('invalid warning');
    return v as string;
  });
  return { provider: 'mediapipe-local', frames, warnings };
}

function localFile(file: string, model = false): string {
  const absolute = assertSafeRepositoryPath(pathResolver.rootResolve(file));
  const relative = path.relative(pathResolver.rootDir(), absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
    fail('input and models must be repository files');
  const stat = safeLstat(absolute);
  if (!stat.isFile() || stat.size <= 0 || stat.size > (model ? 200 : 1024) * 1024 * 1024)
    fail('input/model is not a bounded regular file');
  if (model && path.extname(absolute) !== '.task')
    fail('MediaPipe models must be local .task bundles');
  // Content authorization is stronger than metadata access, without buffering the recording/model.
  safeReadFileRange(absolute, 0, 1);
  return absolute;
}
function integer(value: number | undefined, fallback: number, max: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 1 || result > max) fail(name + ' out of range');
  return result;
}

/** Concrete local-only MediaPipe Tasks adapter. Model assets are explicit; never downloaded by the helper. */
export async function trackMedia(
  request: TrackMediaRequest,
  run: TrackingRunner = safeExecResultAsync
): Promise<TrackingResult> {
  if (!request.faceModel && !request.poseModel && !request.gestureModel)
    throw new Error(
      '[TRACKING_MODEL_REQUIRED] Supply --face-model, --pose-model or --gesture-model pointing to a local MediaPipe .task bundle. Provision model assets under active/shared/cache/system/perception-models/ (or another repo path the scope may read — public or own-tenant tmp/staging).'
    );
  resolvePerceptionScope(request.path);
  const input = localFile(request.path);
  const maxFrames = integer(request.maxFrames, 60, MAX_TRACKING_FRAMES, 'maxFrames');
  const everyMs = integer(request.everyMs, 200, 60000, 'everyMs');
  const timeoutMs = integer(request.timeoutMs, 120000, 600000, 'timeoutMs');
  const args = [
    '-I',
    pathResolver.rootResolve('libs/core/perception/tracking.py'),
    '--input',
    input,
    '--max-frames',
    String(maxFrames),
    '--every-ms',
    String(everyMs),
  ];
  for (const [flag, model] of [
    ['--face-model', request.faceModel],
    ['--pose-model', request.poseModel],
    ['--gesture-model', request.gestureModel],
  ] as const) {
    if (model) args.push(flag, localFile(model, true));
  }
  const result = await run(request.python ?? 'python3', args, {
    timeoutMs,
    maxOutputMB: 12,
    cwd: pathResolver.rootDir(),
    env: { PYTHONDONTWRITEBYTECODE: '1', HF_HUB_OFFLINE: '1' },
  });
  if (result.error || result.status !== 0)
    throw new Error(
      '[TRACKING_UNAVAILABLE] Local MediaPipe tracking failed. Install mediapipe and opencv-python in the selected Python environment and provide compatible local .task bundles. ' +
        (result.error?.message ?? result.stderr).slice(0, 1024)
    );
  if (Buffer.byteLength(result.stdout, 'utf8') > MAX_JSON_BYTES)
    fail('helper output exceeded limit');
  const parsed = parseTrackingResult(
    parseSafeJsonInput(result.stdout.trim(), 'tracking helper result'),
    maxFrames
  );
  if (parsed.frames.length === 0) fail('batch helper returned no frames');
  return parsed;
}

/** Blendshape cues keep the session clock and do not assign a real person's identity. */
export function trackingFrameToAnimationCues(
  frame: TrackingFrame,
  targetAvatarId: string
): AnimationCue[] {
  smallText(targetAvatarId, 'targetAvatarId');
  const checked = parseTrackingResult(
    { provider: 'mediapipe-local', frames: [frame], warnings: [] },
    1
  ).frames[0]!;
  const cues: AnimationCue[] = [];
  const face = checked.faces[0];
  if (face)
    cues.push({
      target_avatar_id: targetAvatarId,
      at_ms: Math.round(checked.time_sec * 1000),
      kind: 'blendshape',
      payload: { ...face.blendshapes },
      source: 'provider',
      provider_id: 'mediapipe-local',
    });
  for (const gesture of checked.gestures)
    cues.push({
      target_avatar_id: targetAvatarId,
      at_ms: Math.round(checked.time_sec * 1000),
      kind: 'gesture',
      payload: { label: gesture.label, handedness: gesture.handedness ?? 'unknown' },
      source: 'provider',
      provider_id: 'mediapipe-local',
      confidence: gesture.confidence,
    });
  return cues;
}

/** Grounded tracking facts reference the original media, not intermediate crop files. */
export function trackingObservations(
  source: PerceptionSource,
  result: TrackingResult
): Observation[] {
  const checked = parseTrackingResult(result);
  const modality: Observation['modality'] = /\.(mp4|mov|m4v|webm|mkv|avi)$/iu.test(source.path)
    ? 'video'
    : 'image';
  const observations: Observation[] = [];
  for (const frame of checked.frames) {
    const base: Pick<Observation, 'modality' | 'provider' | 'finality' | 'time'> = {
      modality,
      provider: checked.provider,
      finality: 'final' as const,
      time: { start_sec: frame.time_sec, end_sec: frame.time_sec, basis: 'decoded' as const },
    };
    for (const [index, face] of frame.faces.entries())
      observations.push(
        observation(source, {
          ...base,
          kind: 'face',
          attributes: {
            face_index: index,
            landmarks: face.landmarks,
            blendshapes: face.blendshapes,
            ...(face.transform ? { transform: face.transform } : {}),
          },
        })
      );
    for (const [index, pose] of frame.poses.entries())
      observations.push(
        observation(source, {
          ...base,
          kind: 'pose',
          attributes: { pose_index: index, landmarks: pose.landmarks },
        })
      );
    for (const gesture of frame.gestures)
      observations.push(
        observation(source, {
          ...base,
          kind: 'gesture',
          text: gesture.label,
          confidence: gesture.confidence,
          attributes: { handedness: gesture.handedness, landmarks: gesture.landmarks },
        })
      );
  }
  return observations;
}

export interface TrackingStreamInput {
  path: string;
  time_sec: number;
}
export interface TrackingStreamOptions extends Omit<TrackMediaRequest, 'path' | 'maxFrames'> {
  signal?: AbortSignal;
  maxFrames?: number;
}
export interface TrackingSession {
  infer(input: TrackingStreamInput): Promise<TrackingFrame>;
  close(): void;
}

/** Resident JSONL helper: one task load per session, one in-flight image and bounded stdout/stderr. */
export function openTrackingSession(
  options: TrackingStreamOptions,
  spawn: typeof spawnManagedProcess = spawnManagedProcess
): TrackingSession {
  if (!options.faceModel && !options.poseModel && !options.gestureModel)
    throw new Error('[TRACKING_MODEL_REQUIRED] A local MediaPipe .task model is required.');
  const limit = integer(options.maxFrames, 60, MAX_TRACKING_FRAMES, 'maxFrames');
  const timeoutMs = integer(options.timeoutMs, 120000, 600000, 'timeoutMs');
  const args = [
    '-I',
    pathResolver.rootResolve('libs/core/perception/tracking.py'),
    '--stream',
    '--max-frames',
    String(limit),
  ];
  for (const [flag, model] of [
    ['--face-model', options.faceModel],
    ['--pose-model', options.poseModel],
    ['--gesture-model', options.gestureModel],
  ] as const)
    if (model) args.push(flag, localFile(model, true));
  const command = options.python ?? 'python3';
  assertGovernedExec(command, args);
  const handle = spawn({
    resourceId: 'perception-tracking-' + randomUUID(),
    kind: 'service',
    ownerId: 'perception-tracking',
    ownerType: 'media-session',
    command,
    args,
    shutdownPolicy: 'manual',
    spawnOptions: {
      cwd: pathResolver.rootDir(),
      shell: false,
      env: buildSafeExecEnv({ PYTHONDONTWRITEBYTECODE: '1', HF_HUB_OFFLINE: '1' }),
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  });
  const child = handle.child;
  let closed = false;
  let failure: Error | undefined;
  let pending:
    | {
        resolve(value: TrackingFrame): void;
        reject(error: Error): void;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined;
  let stdout = '';
  let stderr = '';
  let previous = -1;
  let count = 0;
  const close = () => {
    if (closed) return;
    closed = true;
    options.signal?.removeEventListener('abort', abort);
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(failure ?? new Error('[TRACKING_CLOSED] tracking session closed'));
      pending = undefined;
    }
    child.kill('SIGKILL');
    stopManagedProcess(handle.resourceId, child);
  };
  const failSession = (error: Error) => {
    failure = error;
    close();
  };
  const abort = () => failSession(new Error('[TRACKING_ABORTED] tracking session cancelled'));
  options.signal?.addEventListener('abort', abort, { once: true });
  child.stdin?.on('error', (error) => failSession(error));
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = (stderr + String(chunk)).slice(-8192);
  });
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += String(chunk);
    if (Buffer.byteLength(stdout, 'utf8') > MAX_JSON_BYTES) {
      failSession(new Error('[TRACKING_INVALID] stream output exceeded limit'));
      return;
    }
    if (!stdout.includes('\n')) return;
    const lines = stdout.split('\n');
    const line = lines.shift()!;
    stdout = lines.join('\n');
    if (!pending || stdout.trim()) {
      failSession(new Error('[TRACKING_INVALID] unsolicited stream response'));
      return;
    }
    try {
      const parsed = parseTrackingResult(parseSafeJsonInput(line, 'tracking stream response'), 1);
      if (parsed.frames.length !== 1) fail('stream must return exactly one frame');
      const active = pending;
      pending = undefined;
      clearTimeout(active.timer);
      active.resolve(parsed.frames[0]!);
    } catch (error) {
      failSession(error instanceof Error ? error : new Error(String(error)));
    }
  });
  child.once('error', (error) => failSession(error));
  child.once('close', (status) => {
    if (!closed) {
      if (status === 0 && count >= limit && !pending) close();
      else
        failSession(
          new Error(
            '[TRACKING_UNAVAILABLE] Local MediaPipe stream exited (' +
              String(status) +
              '). Install mediapipe and opencv-python; verify local .task models. ' +
              stderr.slice(-1024)
          )
        );
    }
  });
  if (options.signal?.aborted) abort();
  return {
    close,
    async infer(input) {
      if (failure) throw failure;
      if (closed) throw new Error('[TRACKING_CLOSED] session closed');
      if (pending) fail('only one frame may be in flight');
      if (count >= limit) fail('stream frame budget reached');
      const timestamp = Math.round(finite(input.time_sec, 'stream time_sec', 0, 86400) * 1000);
      if (timestamp <= previous) fail('stream times must increase by at least one millisecond');
      resolvePerceptionScope(input.path);
      const absolute = localFile(input.path);
      if (/\.(mp4|mov|m4v|webm|mkv|avi)$/iu.test(absolute))
        fail('stream input must be a governed captured image');
      const request = JSON.stringify({ path: absolute, time_sec: timestamp / 1000 }) + '\n';
      if (Buffer.byteLength(request) > 8192) fail('stream request exceeded limit');
      previous = timestamp;
      count += 1;
      const frame = await new Promise<TrackingFrame>((resolve, reject) => {
        const timer = setTimeout(
          () => failSession(new Error('[TRACKING_TIMEOUT] frame inference deadline exceeded')),
          timeoutMs
        );
        pending = { resolve, reject, timer };
        child.stdin?.write(request);
      });
      if (Math.abs(frame.time_sec - timestamp / 1000) > 0.000001) {
        failSession(new Error('[TRACKING_INVALID] helper changed source timestamp'));
        throw failure!;
      }
      if (failure) throw failure;
      return frame;
    },
  };
}

/** Abort only races one pending pull; a producer owns cancelling its camera/IO when its return is requested. */
function nextCapturedFrame(
  iterator: AsyncIterator<TrackingStreamInput>,
  signal?: AbortSignal
): Promise<IteratorResult<TrackingStreamInput>> {
  if (!signal) return Promise.resolve(iterator.next());
  if (signal.aborted) return Promise.resolve({ done: true, value: undefined });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value: IteratorResult<TrackingStreamInput>) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      resolve(value);
    };
    const abort = () => finish({ done: true, value: undefined });
    signal.addEventListener('abort', abort, { once: true });
    void Promise.resolve()
      .then(() => (settled ? { done: true as const, value: undefined } : iterator.next()))
      .then(finish, (error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', abort);
        reject(error);
      });
  });
}

/** Pull backpressure keeps no background frame queue. A resident helper reuses models until close/cancel/budget.
 * The producer owns camera consent/capture; this function accepts only already-governed image paths.
 */
export async function* trackFrameStream(
  source: AsyncIterable<TrackingStreamInput>,
  options: TrackingStreamOptions,
  analyze?: typeof trackMedia
): AsyncIterable<TrackingFrame> {
  const limit = integer(options.maxFrames, 60, MAX_TRACKING_FRAMES, 'maxFrames');
  let previous = -1;
  let count = 0;
  let session: TrackingSession | undefined;
  const iterator = source[Symbol.asyncIterator]();
  try {
    while (count < limit) {
      const next = await nextCapturedFrame(iterator, options.signal);
      if (next.done) return;
      const input = next.value;
      if (options.signal?.aborted || count >= limit) return;
      const time = finite(input.time_sec, 'stream time_sec', 0, 86400);
      if (time <= previous) fail('stream times must be strictly increasing');
      previous = time;
      let output: TrackingFrame;
      try {
        if (analyze) {
          const result = parseTrackingResult(
            await analyze({ ...options, path: input.path, maxFrames: 1 }),
            1
          );
          if (result.frames.length !== 1) fail('stream still must return exactly one frame');
          output = { ...result.frames[0]!, time_sec: time };
        } else {
          session ??= openTrackingSession(options);
          output = await session.infer(input);
        }
      } catch (error) {
        if (options.signal?.aborted) return;
        throw error;
      }
      if (options.signal?.aborted) return;
      yield output;
      count += 1;
      if (count >= limit) return;
    }
  } finally {
    session?.close();
    const closeSource = Promise.resolve().then(() => iterator.return?.());
    if (options.signal?.aborted)
      void closeSource.catch((error) =>
        logger.warn(
          'Captured image producer did not close — producer cleanup failed | next: cancel its capture source | evidence: ' +
            String(error)
        )
      );
    else await closeSource;
  }
}
