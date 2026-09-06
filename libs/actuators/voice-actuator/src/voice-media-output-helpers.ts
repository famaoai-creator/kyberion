import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { parseSafeJsonInput, getRegisteredEnvText } from '@agent/core/foundation';
import { getPresenceAvatarProfile } from '@agent/core/presence-avatar';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExec, safeExecResult, safeMkdir } from '@agent/core/secure-io';
import { resolveVoicePath } from '@agent/core/voice-path-policy';
import { installObsVirtualCameraOutputBridge } from '@agent/core/obs-virtual-camera-output';
import { installV4l2VirtualCameraOutputBridge } from '@agent/core/v4l2-virtual-camera-output';
import { resolveCameraOutputBridge } from '@agent/core/camera-output-bridge';

const STT_READY_SAMPLE_RATE = 16000;
const STT_READY_CHANNELS = 1;

interface AudioStreamProbe {
  codec?: string;
  sampleRate?: number;
  channels?: number;
  format?: string;
}

function probeAudioFile(audioPath: string): AudioStreamProbe {
  const result = safeExecResult(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'a:0',
      '-show_entries',
      'stream=codec_name,sample_rate,channels:format=format_name',
      '-of',
      'json',
      audioPath,
    ],
    { timeoutMs: 30_000 }
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      `[VOICE] ffprobe failed for ${audioPath}: ${result.error?.message || result.stderr || `exit ${result.status}`}. Install ffmpeg (voice dependency bundle).`
    );
  }
  let parsed: any;
  try {
    parsed = parseSafeJsonInput(result.stdout, 'ffprobe response');
  } catch {
    throw new Error(`[VOICE] ffprobe returned non-JSON for ${audioPath}.`);
  }
  const stream = parsed?.streams?.[0] ?? {};
  return {
    ...(typeof stream.codec_name === 'string' ? { codec: stream.codec_name } : {}),
    ...(Number.isFinite(Number(stream.sample_rate))
      ? { sampleRate: Number(stream.sample_rate) }
      : {}),
    ...(Number.isFinite(Number(stream.channels)) ? { channels: Number(stream.channels) } : {}),
    ...(typeof parsed?.format?.format_name === 'string'
      ? { format: String(parsed.format.format_name).split(',')[0] }
      : {}),
  };
}

function isSttReadyAudio(probe: AudioStreamProbe): boolean {
  return (
    probe.codec === 'pcm_s16le' &&
    probe.sampleRate === STT_READY_SAMPLE_RATE &&
    probe.channels === STT_READY_CHANNELS &&
    probe.format === 'wav'
  );
}

/** Ensure audio is 16kHz mono PCM wav without mutating the source. */
export function ensureSttReadyAudio(audioPath: string): { path: string; converted: boolean } {
  const probe = probeAudioFile(audioPath);
  if (isSttReadyAudio(probe)) return { path: audioPath, converted: false };
  const digest = createHash('sha256').update(audioPath).digest('hex').slice(0, 16);
  const outputPath = resolveVoicePath(
    pathResolver.sharedTmp(`stt-normalized/${digest}.wav`),
    'recording-output'
  );
  safeMkdir(path.dirname(outputPath), { recursive: true });
  safeExec('ffmpeg', [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    audioPath,
    '-ac',
    '1',
    '-ar',
    String(STT_READY_SAMPLE_RATE),
    '-c:a',
    'pcm_s16le',
    outputPath,
  ]);
  return { path: outputPath, converted: true };
}

export function normalizeAudioSample(input: {
  action: 'normalize_audio';
  audio_path: string;
  output_path?: string;
}): Record<string, unknown> {
  const audioPath = resolveVoicePath(String(input.audio_path || '').trim(), 'audio-input');
  const probe = probeAudioFile(audioPath);
  if (isSttReadyAudio(probe)) {
    return {
      status: 'succeeded',
      action: 'normalize_audio',
      audio_path: audioPath,
      normalized_path: audioPath,
      converted: false,
      probe,
    };
  }
  const requested = String(input.output_path || '').trim();
  const outputPath = requested
    ? resolveVoicePath(requested, 'recording-output')
    : ensureSttReadyAudio(audioPath).path;
  if (requested) {
    safeMkdir(path.dirname(outputPath), { recursive: true });
    safeExec('ffmpeg', [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      audioPath,
      '-ac',
      '1',
      '-ar',
      String(STT_READY_SAMPLE_RATE),
      '-c:a',
      'pcm_s16le',
      outputPath,
    ]);
  }
  return {
    status: 'succeeded',
    action: 'normalize_audio',
    audio_path: audioPath,
    normalized_path: outputPath,
    converted: true,
    probe,
  };
}

const RASTER_AVATAR_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

function resolveAvatarPortrait(portraitPath?: string, avatarName?: string): string {
  const requested = String(portraitPath || '').trim();
  if (requested) return resolveVoicePath(requested, 'audio-input');
  const name = String(avatarName || '').trim();
  if (!name) {
    throw new Error(
      '[VOICE] render_talking_avatar needs portrait_path or avatar_name (a presence-avatar profile with a raster asset)'
    );
  }
  const profile = getPresenceAvatarProfile(name);
  const asset = String(profile.defaultAvatarAssetPath || '').trim();
  if (!asset) throw new Error(`[VOICE] avatar profile '${name}' has no portrait asset`);
  const ext = path.extname(asset).toLowerCase();
  if (!RASTER_AVATAR_EXTENSIONS.has(ext)) {
    throw new Error(
      `[VOICE] avatar profile '${name}' asset is ${ext || 'extensionless'} — provide a PNG/JPG portrait via portrait_path (SVG assets cannot be rasterized here)`
    );
  }
  const candidate = asset.startsWith('/')
    ? pathResolver.rootResolve(asset.replace(/^\/+/, ''))
    : asset;
  return resolveVoicePath(candidate, 'audio-input');
}

function synthesizeSpeechAiff(text: string, voice: string, outputPath: string): void {
  if (process.platform !== 'darwin') {
    throw new Error(
      '[VOICE] render_talking_avatar text-to-audio needs macOS `say` on this machine; pass audio_path instead'
    );
  }
  safeExec('say', ['-v', voice, '-o', outputPath, text]);
}

export function renderTalkingAvatar(input: {
  action: 'render_talking_avatar';
  portrait_path?: string;
  avatar_name?: string;
  text?: string;
  audio_path?: string;
  output_path?: string;
  language?: string;
  voice?: string;
  fps?: number;
  max_duration_sec?: number;
  mouth_x?: number;
  mouth_y?: number;
  mouth_w?: number;
  eyes_y?: number;
}): Record<string, unknown> {
  const portraitPath = resolveAvatarPortrait(input.portrait_path, input.avatar_name);
  let wavPath: string | undefined;
  const givenAudio = String(input.audio_path || '').trim();
  if (givenAudio) {
    wavPath = ensureSttReadyAudio(resolveVoicePath(givenAudio, 'audio-input')).path;
  } else {
    const text = String(input.text || '').trim();
    if (!text) throw new Error('[VOICE] render_talking_avatar needs text or audio_path');
    const digest = createHash('sha256').update(text).digest('hex').slice(0, 16);
    const aiffPath = resolveVoicePath(
      pathResolver.sharedTmp(`talking-avatar/${digest}.aiff`),
      'recording-output'
    );
    safeMkdir(path.dirname(aiffPath), { recursive: true });
    synthesizeSpeechAiff(text, String(input.voice || 'Kyoko').trim() || 'Kyoko', aiffPath);
    wavPath = ensureSttReadyAudio(aiffPath).path;
  }
  const requested = String(input.output_path || '').trim();
  const outputPath = requested
    ? resolveVoicePath(requested, 'recording-output')
    : resolveVoicePath(
        pathResolver.sharedTmp(
          `talking-avatar/${createHash('sha256').update(`${portraitPath}:${wavPath}`).digest('hex').slice(0, 16)}.mp4`
        ),
        'recording-output'
      );
  safeMkdir(path.dirname(outputPath), { recursive: true });
  const script = pathResolver.rootResolve(
    'libs/actuators/voice-actuator/scripts/talking_avatar_render.py'
  );
  const args = [
    script,
    '--portrait',
    portraitPath,
    '--audio',
    wavPath,
    '--output',
    outputPath,
    '--fps',
    String(Math.min(30, Math.max(5, Number(input.fps) || 12))),
    '--max-duration-sec',
    String(Math.max(5, Number(input.max_duration_sec) || 300)),
  ];
  const pushFlag = (flag: string, value: unknown): void => {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) args.push(flag, String(numeric));
  };
  pushFlag('--mouth-x', input.mouth_x);
  pushFlag('--mouth-y', input.mouth_y);
  pushFlag('--mouth-w', input.mouth_w);
  pushFlag('--eyes-y', input.eyes_y);
  const result = safeExecResult('python3', args, { timeoutMs: 10 * 60 * 1000 });
  if (result.error || result.status !== 0) {
    throw new Error(
      `[VOICE] talking-avatar render failed: ${result.error?.message || result.stderr?.slice(0, 500) || `exit ${result.status}`}`
    );
  }
  let report: any;
  try {
    report = parseSafeJsonInput(result.stdout, 'talking_avatar_render response');
  } catch {
    throw new Error('[VOICE] talking-avatar render returned non-JSON');
  }
  if (!report || report.status !== 'success') {
    throw new Error(`[VOICE] talking-avatar render error: ${report?.message || 'unknown'}`);
  }
  return {
    status: 'succeeded',
    action: 'render_talking_avatar',
    portrait_path: portraitPath,
    audio_path: wavPath,
    video_path: String(report.output || outputPath),
    duration_sec: report.duration_sec,
    fps: report.fps,
    frames: report.frames,
  };
}

export function outputToVirtualCamera(input: {
  action: 'output_to_virtual_camera';
  video_path?: string;
  backend?: string;
  scene_name?: string;
  source_name?: string;
  loop?: boolean;
  stop?: boolean;
  obs_host?: string;
  obs_port?: number;
  obs_password?: string;
  v4l2_device_path?: string;
}): Promise<Record<string, unknown>> {
  const password =
    String(input.obs_password || '').trim() ||
    String(getRegisteredEnvText('KYBERION_OBS_WS_PASSWORD') || '').trim();
  installObsVirtualCameraOutputBridge({
    ...(String(input.obs_host || '').trim() ? { host: String(input.obs_host).trim() } : {}),
    ...(Number.isFinite(Number(input.obs_port)) ? { port: Number(input.obs_port) } : {}),
    ...(password ? { password } : {}),
  });
  installV4l2VirtualCameraOutputBridge({
    ...(String(input.v4l2_device_path || '').trim()
      ? { devicePath: String(input.v4l2_device_path).trim() }
      : {}),
  });
  const backend = String(input.backend || 'auto').trim() || 'auto';
  if (input.stop) {
    return resolveCameraOutputBridge(backend)
      .then((bridge) => bridge.stopAvatarOutput())
      .then(() => ({
        status: 'succeeded',
        action: 'output_to_virtual_camera',
        backend,
        stopped: true,
      }))
      .catch((err: unknown) => {
        throw new Error(
          `[VOICE] camera output stop failed: ${err instanceof Error ? err.message : String(err)}`
        );
      });
  }
  const requestedVideo = String(input.video_path || '').trim();
  if (!requestedVideo) {
    throw new Error('[VOICE] output_to_virtual_camera needs video_path (or stop: true)');
  }
  const videoPath = resolveVoicePath(requestedVideo, 'audio-input');
  return resolveCameraOutputBridge(backend)
    .then((bridge) =>
      bridge.startAvatarOutput({
        videoPath,
        ...(String(input.scene_name || '').trim()
          ? { sceneName: String(input.scene_name).trim() }
          : {}),
        ...(String(input.source_name || '').trim()
          ? { sourceName: String(input.source_name).trim() }
          : {}),
        ...(input.loop !== undefined ? { loop: Boolean(input.loop) } : {}),
      })
    )
    .then((result) => ({
      status: 'succeeded',
      action: 'output_to_virtual_camera',
      backend,
      video_path: videoPath,
      ...result,
    }))
    .catch((err: unknown) => {
      throw new Error(
        `[VOICE] camera output failed: ${err instanceof Error ? err.message : String(err)}`
      );
    });
}
