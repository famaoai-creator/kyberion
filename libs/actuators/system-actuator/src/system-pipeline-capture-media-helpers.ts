/** Camera + microphone capture ops for the system pipeline actuator.
 *
 * Houses the `record_audio` / `capture_photo` / `record_camera` capture ops
 * plus the camera probe and `test_camera_*` diagnostic ops, keeping
 * `system-pipeline-core-helpers.ts` under the file-length gate. The op switch
 * there delegates to the `run*` functions below; op names and behavior are
 * unchanged by the move.
 */

import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertSafeRepositoryPath, safeExistsSync, safeMkdir } from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import { createVirtualAudioInputRecordingBridge } from '@agent/core/virtual/virtual-audio-input-recording-bridge';
import { createVirtualCameraBridge } from '@agent/core/virtual/virtual-camera-bridge';
import { createVirtualCameraInjectionBridge } from '@agent/core/virtual/virtual-camera-injection-bridge';
import { createVirtualDeviceInventoryBridge } from '@agent/core/virtual/virtual-device-inventory-bridge';
import { StubVideoFrameBus } from '@agent/core/video/video-frame-bus';
import {
  writeVideoFramesToMp4,
  pipeMp4ToVideoFrameBus,
} from '@agent/core/video/video-frame-archive';
import type { VideoFrame } from '@agent/core/meeting/meeting-session-types';

export type CaptureMediaParams = Record<string, unknown>;
export type CaptureMediaCtx = Record<string, unknown>;
export type ResolveValue = (value: unknown) => unknown;

function exportKey(params: CaptureMediaParams, fallback: string): string {
  return typeof params.export_as === 'string' && params.export_as ? params.export_as : fallback;
}

function optionalString(params: CaptureMediaParams, key: string): string | undefined {
  return typeof params[key] === 'string' ? (params[key] as string) : undefined;
}

function resolveSystemPath(ref: string, allowMissingLeaf = true): string {
  return assertSafeRepositoryPath(pathResolver.rootResolve(ref), { allowMissingLeaf });
}

/** Replay finitely-collected frames as a stream: draining a closed
 * StubVideoFrameBus yields nothing, and draining an open one blocks once the
 * buffer empties — collected-then-replayed never loses the recording. */
export async function* replayCollectedFrames(frames: VideoFrame[]): AsyncIterable<VideoFrame> {
  for (const frame of frames) {
    yield frame;
  }
}

export const AUDIO_RECORDING_EXTENSIONS: readonly string[] = [
  '.wav',
  '.mp3',
  '.m4a',
  '.aac',
  '.flac',
  '.ogg',
  '.opus',
];

function slugifyAudioInputName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'input';
}

function assertWithinAudioRecordingRoots(absolute: string, what: string): string {
  const allowedRoots = [
    path.resolve(pathResolver.shared('runtime/computer/audio-recordings')),
    path.resolve(pathResolver.shared('tmp')),
  ];
  if (
    !allowedRoots.some((root) => absolute === root || absolute.startsWith(`${root}${path.sep}`))
  ) {
    throw new Error(`${what} must remain within the governed audio-recording or shared tmp store`);
  }
  return assertSafeRepositoryPath(absolute, { allowMissingLeaf: true });
}

export function resolveCanonicalAudioRecordingPath(requestedOutput: string): string {
  const absolute = path.resolve(pathResolver.rootResolve(requestedOutput));
  return assertWithinAudioRecordingRoots(absolute, 'record_audio output file');
}

export function resolveCanonicalAudioRecordingDir(
  requestedOutput: string,
  resolve: ResolveValue
): string {
  const candidate = requestedOutput
    ? pathResolver.rootResolve(String(resolve(requestedOutput)))
    : pathResolver.shared(`runtime/computer/audio-recordings/audio-${Date.now()}`);
  const absolute = path.resolve(candidate);
  const resolved = assertWithinAudioRecordingRoots(absolute, 'record_audio output directory');
  if (!safeExistsSync(resolved)) {
    safeMkdir(resolved, { recursive: true });
  }
  return resolved;
}

export function resolveCanonicalPhotoCapturePath(
  params: CaptureMediaParams,
  resolve: ResolveValue
): string {
  const requested =
    typeof params.path === 'string' && params.path.trim()
      ? pathResolver.rootResolve(String(resolve(params.path)))
      : pathResolver.shared(`runtime/computer/photos/photo-${Date.now()}-${randomUUID()}.jpg`);
  const absolute = path.resolve(requested);
  const allowedRoots = [
    path.resolve(pathResolver.shared('runtime/computer/photos')),
    path.resolve(pathResolver.shared('tmp')),
  ];
  if (
    !allowedRoots.some((root) => absolute === root || absolute.startsWith(`${root}${path.sep}`))
  ) {
    throw new Error(
      'capture_photo output must remain within the governed photo or shared tmp store'
    );
  }
  return assertSafeRepositoryPath(absolute, { allowMissingLeaf: true });
}

export function resolveCanonicalCameraRecordingPath(
  params: CaptureMediaParams,
  resolve: ResolveValue = (value) => value
): string {
  const requested = typeof params.output === 'string' ? params.output.trim() : '';
  const candidate = requested
    ? pathResolver.rootResolve(String(resolve(requested)))
    : pathResolver.shared(`runtime/computer/camera-recordings/camera-${Date.now()}.mp4`);
  const absolute = path.resolve(candidate);
  const allowedRoots = [
    path.resolve(pathResolver.shared('runtime/computer/camera-recordings')),
    path.resolve(pathResolver.shared('tmp')),
  ];
  if (
    !allowedRoots.some((root) => absolute === root || absolute.startsWith(`${root}${path.sep}`))
  ) {
    throw new Error(
      'record_camera output must remain within the governed camera-recording or shared tmp store'
    );
  }
  return assertSafeRepositoryPath(absolute, { allowMissingLeaf: true });
}

export async function runRecordAudioOp(
  params: CaptureMediaParams,
  ctx: CaptureMediaCtx,
  resolve: ResolveValue
): Promise<CaptureMediaCtx> {
  const bridge = createVirtualAudioInputRecordingBridge();
  const availability = await bridge.probe();
  if (!availability.available) {
    throw new Error(
      `record_audio unavailable: ${availability.reason || 'audio input bridge unavailable'}`
    );
  }
  const durationRaw = params.duration ?? params.duration_sec;
  const durationValue = durationRaw === undefined ? 3 : Number(durationRaw);
  if (!Number.isFinite(durationValue) || durationValue <= 0) {
    throw new Error(`record_audio duration must be 1-300 seconds, got "${String(durationRaw)}"`);
  }
  const durationSec = durationValue;
  if (durationSec > 300) {
    throw new Error(`record_audio duration must be 1-300 seconds, got "${durationSec}"`);
  }
  const requestedTargets = Array.isArray(params.targets)
    ? (params.targets as unknown[]).map((entry) => String(entry).trim()).filter(Boolean)
    : [];
  const selectedInputs = requestedTargets.length > 0 ? requestedTargets : availability.inputs;
  if (selectedInputs.length === 0) {
    throw new Error('record_audio: no audio inputs available on this machine');
  }
  const requestedOutput =
    typeof params.output === 'string' && params.output.trim() ? params.output.trim() : '';
  const outputExt = requestedOutput
    ? path.extname(pathResolver.rootResolve(String(resolve(requestedOutput)))).toLowerCase()
    : '';
  const fileMode = requestedOutput !== '' && AUDIO_RECORDING_EXTENSIONS.includes(outputExt);
  if (fileMode && selectedInputs.length !== 1) {
    throw new Error(
      `record_audio: output file "${requestedOutput}" needs exactly one input ` +
        `(${selectedInputs.length} selected). Pass targets with a single device or omit output.`
    );
  }
  const baseDir = fileMode
    ? ''
    : resolveCanonicalAudioRecordingDir(
        requestedOutput ? String(resolve(requestedOutput)) : '',
        resolve
      );
  const recordings: Array<Record<string, unknown>> = [];
  for (const inputName of selectedInputs) {
    const recordingPath = fileMode
      ? resolveCanonicalAudioRecordingPath(String(resolve(requestedOutput)))
      : path.join(baseDir, `${slugifyAudioInputName(inputName)}.wav`);
    if (!fileMode && !safeExistsSync(path.dirname(recordingPath))) {
      safeMkdir(path.dirname(recordingPath), { recursive: true });
    }
    const result = await bridge.recordOnInputs([inputName], {
      duration_sec: durationSec,
      output_path: recordingPath,
    });
    for (const entry of result.recordings) recordings.push({ ...entry });
  }
  const failed = recordings.filter((entry) => entry.status !== 'recorded');
  if (failed.length > 0) {
    const detail = failed
      .map((entry) => `${String(entry.device_name)}: ${String(entry.error || entry.status)}`)
      .join('; ');
    throw new Error(`record_audio: ${failed.length} input(s) failed: ${detail}`);
  }
  return {
    ...ctx,
    [exportKey(params, 'audio_recording')]: {
      status: 'succeeded',
      bridge_id: bridge.bridge_id,
      duration_sec: durationSec,
      recordings,
    },
  };
}

export async function runCapturePhotoOp(
  params: CaptureMediaParams,
  ctx: CaptureMediaCtx,
  resolve: ResolveValue
): Promise<CaptureMediaCtx> {
  const bridge = createVirtualCameraBridge();
  const photoPath = resolveCanonicalPhotoCapturePath(params, resolve);
  if (!safeExistsSync(path.dirname(photoPath))) {
    safeMkdir(path.dirname(photoPath), { recursive: true });
  }
  const cameraIntent =
    params.camera_intent === 'record' ||
    params.camera_intent === 'share' ||
    params.camera_intent === 'ocr_source'
      ? params.camera_intent
      : 'reference';
  const result = await bridge.capturePhoto({
    save_path: photoPath,
    camera_intent: cameraIntent,
    subject_hint: optionalString(params, 'subject_hint'),
    device_preference: optionalString(params, 'device_preference'),
  });
  return {
    ...ctx,
    [exportKey(params, 'photo_path')]: photoPath,
    photo_path: photoPath,
    photo_backend: result.backend,
    photo_camera: result.selected_camera,
    photo_intent: result.camera_intent,
  };
}

export async function runRecordCameraOp(
  params: CaptureMediaParams,
  ctx: CaptureMediaCtx,
  resolve: ResolveValue
): Promise<CaptureMediaCtx> {
  // Camera video is photo-per-frame (see captureStream), so this is
  // low-fps by construction — timelapse grade, unlike screen recording.
  const bridge = createVirtualCameraBridge();
  const fpsRaw = params.fps ?? 2;
  const fpsValue = Number(fpsRaw);
  if (!Number.isFinite(fpsValue) || fpsValue <= 0 || fpsValue > 5) {
    throw new Error(`record_camera fps must be 1-5, got "${String(fpsRaw)}"`);
  }
  const fps = fpsValue;
  const durationRaw = params.duration;
  const durationValue = durationRaw === undefined ? 5 : Number(durationRaw);
  if (!Number.isFinite(durationValue) || durationValue <= 0) {
    throw new Error(`record_camera duration must be 1-60 seconds, got "${String(durationRaw)}"`);
  }
  const durationSec = durationValue;
  if (durationSec > 60) {
    throw new Error(`record_camera duration must be 1-60 seconds, got "${durationSec}"`);
  }
  const frameCount = Math.min(300, Math.max(1, Math.ceil(durationSec * fps)));
  const frameIntervalMs = Math.max(200, Math.round(1000 / fps));
  const outputPath = resolveCanonicalCameraRecordingPath(params, resolve);
  // Collect frames directly from the capture stream: draining a closed
  // StubVideoFrameBus yields nothing, and draining an open one blocks
  // once the buffer empties — both lose the recording.
  const frames: VideoFrame[] = [];
  for await (const frame of bridge.captureStream({
    max_frames: frameCount,
    frame_interval_ms: frameIntervalMs,
    camera_intent: 'record',
    subject_hint: optionalString(params, 'subject_hint'),
    device_preference: optionalString(params, 'device_preference'),
  })) {
    frames.push(frame);
  }
  if (frames.length === 0) {
    throw new Error('record_camera: the camera produced no frames');
  }
  const exported = await writeVideoFramesToMp4(outputPath, replayCollectedFrames(frames), {
    fps,
  });
  const probe = await bridge.probe();
  return {
    ...ctx,
    [exportKey(params, 'camera_recording')]: {
      status: 'succeeded',
      bridge_id: bridge.bridge_id,
      selected_camera: probe.selected_camera,
      output_path: exported.output_path,
      frame_count: exported.frame_count,
      fps,
      duration_sec: durationSec,
    },
  };
}

export async function runCameraCaptureProbe(
  params: CaptureMediaParams,
  ctx: CaptureMediaCtx
): Promise<CaptureMediaCtx> {
  const bridge = createVirtualCameraBridge();
  const probe = await bridge.probe();
  return { ...ctx, [exportKey(params, 'camera_capture')]: probe };
}

export async function runCameraInjectionProbe(
  params: CaptureMediaParams,
  ctx: CaptureMediaCtx
): Promise<CaptureMediaCtx> {
  const bridge = createVirtualCameraInjectionBridge();
  const probe = await bridge.probe();
  return { ...ctx, [exportKey(params, 'camera_injection')]: probe };
}

export async function runTestCameraStreamOp(
  params: CaptureMediaParams,
  ctx: CaptureMediaCtx
): Promise<CaptureMediaCtx> {
  const bridge = createVirtualCameraBridge();
  const bus = new StubVideoFrameBus();
  await bridge.pipeTo(bus, {
    max_frames: Math.max(1, Number(params.frame_count || 2)),
    frame_interval_ms: Math.max(0, Number(params.frame_interval_ms || 250)),
    camera_intent: 'record',
    subject_hint: optionalString(params, 'subject_hint'),
  });
  const frames: VideoFrame[] = [];
  for await (const frame of bus.frameStream()) {
    frames.push(frame);
    if (frames.length >= Math.max(1, Number(params.frame_count || 2))) {
      break;
    }
  }
  await bus.close();
  const probe = await bridge.probe();
  return {
    ...ctx,
    [exportKey(params, 'camera_stream_test')]: {
      bridge_id: bridge.bridge_id,
      backend: probe.backend || 'stub',
      selected_camera: probe.selected_camera,
      frame_count: frames.length,
      frames,
    },
  };
}

export async function runTestCameraMp4RoundtripOp(
  params: CaptureMediaParams,
  ctx: CaptureMediaCtx
): Promise<CaptureMediaCtx> {
  const bridge = createVirtualCameraBridge();
  const frames: VideoFrame[] = [];
  for await (const frame of bridge.captureStream({
    max_frames: Math.max(1, Number(params.frame_count || 2)),
    frame_interval_ms: Math.max(0, Number(params.frame_interval_ms || 250)),
    camera_intent: 'record',
    subject_hint: optionalString(params, 'subject_hint'),
  })) {
    frames.push(frame);
  }
  const outputPath = pathResolver.shared(`runtime/computer/camera-roundtrip-${Date.now()}.mp4`);
  const exported = await writeVideoFramesToMp4(outputPath, replayCollectedFrames(frames), {
    fps: Math.max(1, Math.round(1000 / Math.max(1, Number(params.frame_interval_ms || 250)))),
  });
  const importBus = new StubVideoFrameBus();
  await pipeMp4ToVideoFrameBus(exported.output_path, importBus);
  let importedFrameCount = 0;
  const importDeadline = Date.now() + 15_000;
  for await (const frame of importBus.frameStream()) {
    void frame;
    importedFrameCount += 1;
    if (importedFrameCount >= exported.frame_count || Date.now() > importDeadline) break;
  }
  await importBus.close();
  const probe = await bridge.probe();
  return {
    ...ctx,
    [exportKey(params, 'camera_mp4_roundtrip')]: {
      bridge_id: bridge.bridge_id,
      selected_camera: probe.selected_camera,
      exported_mp4_path: exported.output_path,
      exported_frame_count: exported.frame_count,
      imported_frame_count: importedFrameCount,
    },
  };
}

export async function runTestCameraInjectionOp(
  params: CaptureMediaParams,
  ctx: CaptureMediaCtx
): Promise<CaptureMediaCtx> {
  const inventoryBridge = createVirtualDeviceInventoryBridge();
  const cameraBridge = createVirtualCameraBridge({
    inventory_bridge: inventoryBridge,
    device_preference:
      optionalString(params, 'camera_device_preference') ??
      optionalString(params, 'device_preference'),
    preferred_backend: optionalString(params, 'preferred_camera_backend'),
  });
  const injectionBridge = createVirtualCameraInjectionBridge({
    inventory_bridge: inventoryBridge,
    device_preference:
      optionalString(params, 'camera_device_preference') ??
      optionalString(params, 'device_preference'),
    device_path: optionalString(params, 'device_path'),
  });
  const frameCount = Math.max(1, Number(params.frame_count || 3));
  const frameIntervalMs = Math.max(0, Number(params.frame_interval_ms || 250));
  const mp4Path =
    typeof params.input_mp4_path === 'string' && params.input_mp4_path.trim()
      ? resolveSystemPath(params.input_mp4_path.trim(), false)
      : pathResolver.shared(`runtime/computer/video/camera-injection-${Date.now()}.mp4`);
  let sourcePath = mp4Path;
  if (!(typeof params.input_mp4_path === 'string' && params.input_mp4_path.trim())) {
    const frames: VideoFrame[] = [];
    for await (const frame of cameraBridge.captureStream({
      device_preference:
        optionalString(params, 'camera_device_preference') ??
        optionalString(params, 'device_preference'),
      max_frames: frameCount,
      frame_interval_ms: frameIntervalMs,
      camera_intent: 'record',
      subject_hint: optionalString(params, 'subject_hint'),
    })) {
      frames.push(frame);
    }
    const exportResult = await writeVideoFramesToMp4(mp4Path, replayCollectedFrames(frames), {
      fps: Math.max(1, Math.round(1000 / Math.max(1, frameIntervalMs || 250))),
    });
    sourcePath = exportResult.output_path;
  }
  const injectionResult = await injectionBridge.injectFromMp4(sourcePath, {
    source_path: sourcePath,
    device_preference:
      optionalString(params, 'camera_device_preference') ??
      optionalString(params, 'device_preference'),
    device_path: optionalString(params, 'device_path'),
    output_path: optionalString(params, 'output_path'),
    fps: Math.max(1, Math.round(1000 / Math.max(1, frameIntervalMs || 250))),
    subject_hint: optionalString(params, 'subject_hint'),
  });
  return {
    ...ctx,
    [exportKey(params, 'camera_injection_test')]: injectionResult,
  };
}
