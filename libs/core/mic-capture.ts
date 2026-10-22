/* eslint-disable no-restricted-imports */
/**
 * Standalone microphone capture — the entry point for "record the room"
 * flows (in-room minutes, in-room meeting attendance). Unlike the meeting
 * audio buses (BlackHole/Pulse loopback of *meeting* audio), this captures
 * the physical microphone directly via ffmpeg (macOS avfoundation) or
 * arecord (Linux), emitting PCM_S16LE mono chunks compatible with
 * `AudioChunk` consumers (EnergyVad, STT bridges).
 */

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AudioChunk } from './meeting/meeting-session-types.js';
import { resolveFfmpegBin } from './tool/tool-binary-resolvers.js';

export interface MicCaptureOptions {
  /** Input device: avfoundation index (":0") on darwin, ALSA device on linux. */
  device?: string;
  /**
   * Logical capture source, resolved to a device on darwin when `device` is
   * not given: `mic` = physical microphone (room audio), `system` = virtual
   * loopback such as BlackHole (remote audio), `both` = the two mixed.
   */
  source?: MicCaptureSource;
  sampleRateHz?: 16000 | 24000 | 48000;
  /** Milliseconds of audio per emitted chunk. */
  chunkMs?: number;
  /**
   * Full command override (argv array). When provided, it is spawned as-is
   * and must write PCM_S16LE mono at sampleRateHz to stdout. Used by tests
   * to replay fixture audio deterministically.
   */
  command?: string[];
}

export type MicCaptureSource = 'mic' | 'system' | 'both';

export interface MicCaptureSession {
  chunks(): AsyncIterable<AudioChunk>;
  stop(): Promise<void>;
}

export interface MicCaptureProbeResult {
  available: boolean;
  backend: 'ffmpeg-avfoundation' | 'ffmpeg-dshow' | 'arecord' | 'custom' | 'none';
  reason?: string;
}

const MAC_VIRTUAL_AUDIO_DEVICE_RE =
  /blackhole|soundflower|loopback|virtual|aggregate|multi-output/i;
/** Loopback drivers that carry system audio, best first. */
const MAC_SYSTEM_AUDIO_PRIORITY = [/blackhole/i, /loopback/i, /soundflower/i];

interface MicCapturePlatformAdapter {
  backend: Exclude<MicCaptureProbeResult['backend'], 'custom' | 'none'>;
  binary: string;
  resolveDevice(explicit?: string): string;
  /** Device(s) to open; more than one is mixed (darwin only). */
  resolveSource?(source: MicCaptureSource): string[];
  command(devices: string[], sampleRateHz: number): string[];
}

class DarwinMicCaptureAdapter implements MicCapturePlatformAdapter {
  backend = 'ffmpeg-avfoundation' as const;
  binary = resolveFfmpegBin();
  resolveDevice(explicit?: string): string {
    if (explicit?.trim()) return explicit.trim();
    return detectMacPhysicalAudioDevice() || ':0';
  }
  resolveSource(source: MicCaptureSource): string[] {
    return resolveMacCaptureSource(detectMacAudioListing(), source);
  }
  command(devices: string[], sampleRateHz: number): string[] {
    const inputs = devices.flatMap((d) => ['-f', 'avfoundation', '-i', d]);
    // Several inputs run on independent clocks: resample each to a common
    // timeline, mix (amix divides by N, so scale back up), then limit so
    // speaker bleed into the mic cannot clip s16.
    const n = devices.length;
    const mix =
      n > 1
        ? [
            '-filter_complex',
            `${devices.map((_, i) => `[${i}:a]aresample=async=1[a${i}]`).join(';')};` +
              `${devices.map((_, i) => `[a${i}]`).join('')}` +
              `amix=inputs=${n}:duration=longest,volume=${n},alimiter=limit=0.95[mix]`,
            '-map',
            '[mix]',
          ]
        : [];
    return [
      resolveFfmpegBin(),
      '-hide_banner',
      '-loglevel',
      'error',
      ...inputs,
      ...mix,
      '-ac',
      '1',
      '-ar',
      String(sampleRateHz),
      '-f',
      's16le',
      '-',
    ];
  }
}

class LinuxMicCaptureAdapter implements MicCapturePlatformAdapter {
  backend = 'arecord' as const;
  binary = 'arecord';
  resolveDevice(explicit?: string): string {
    return explicit?.trim() || ':0';
  }
  command(devices: string[], sampleRateHz: number): string[] {
    const device = devices[0];
    return [
      'arecord',
      ...(device !== ':0' ? ['-D', device] : []),
      '-f',
      'S16_LE',
      '-r',
      String(sampleRateHz),
      '-c',
      '1',
      '-t',
      'raw',
    ];
  }
}

class WindowsMicCaptureAdapter implements MicCapturePlatformAdapter {
  backend = 'ffmpeg-dshow' as const;
  binary = resolveFfmpegBin();
  resolveDevice(explicit?: string): string {
    return explicit?.trim() || 'default';
  }
  command(devices: string[], sampleRateHz: number): string[] {
    const device = devices[0];
    return [
      resolveFfmpegBin(),
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'dshow',
      '-i',
      `audio="${device.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`,
      '-ac',
      '1',
      '-ar',
      String(sampleRateHz),
      '-f',
      's16le',
      '-',
    ];
  }
}

function resolveMicCaptureAdapter(platform: NodeJS.Platform): MicCapturePlatformAdapter {
  switch (platform) {
    case 'darwin':
      return new DarwinMicCaptureAdapter();
    case 'win32':
      return new WindowsMicCaptureAdapter();
    default:
      return new LinuxMicCaptureAdapter();
  }
}

export interface MacAudioDevice {
  /** avfoundation device string, e.g. ":1". */
  device: string;
  name: string;
  /** Loopback / aggregate drivers rather than physical hardware. */
  virtual: boolean;
}

/** Parse ffmpeg's `-list_devices` output into the audio input devices it names. */
export function listMacAudioDevices(listing: string): MacAudioDevice[] {
  const devices: MacAudioDevice[] = [];
  let inAudioSection = false;
  for (const line of listing.split(/\r?\n/u)) {
    if (/AVFoundation audio devices:/u.test(line)) {
      inAudioSection = true;
      continue;
    }
    if (!inAudioSection) continue;
    // Parse `] [N] name` without a regex — an unanchored `$`-pattern scan is
    // quadratic on attacker-controlled line text (polynomial-redos).
    const ws = ' \t\n\r\v\f\u00a0';
    let match: { index: string; name: string } | null = null;
    for (
      let bracket = line.indexOf(']');
      bracket >= 0 && !match;
      bracket = line.indexOf(']', bracket + 1)
    ) {
      let j = bracket + 1;
      while (j < line.length && ws.includes(line[j])) j += 1;
      if (line[j] !== '[') continue;
      const numEnd = line.indexOf(']', j);
      if (numEnd < 0) break;
      const index = line.slice(j + 1, numEnd);
      if (!/^\d+$/u.test(index)) continue;
      let k = numEnd + 1;
      while (k < line.length && ws.includes(line[k])) k += 1;
      const name = line.slice(k).trim();
      if (name) match = { index, name };
    }
    if (!match) continue;
    devices.push({
      device: `:${match.index}`,
      name: match.name,
      virtual: MAC_VIRTUAL_AUDIO_DEVICE_RE.test(match.name),
    });
  }
  return devices;
}

/**
 * Select the first physical AVFoundation audio input from ffmpeg's device
 * listing. macOS device indices are host-specific; `:0` is not a safe
 * default because virtual devices such as BlackHole often occupy it.
 */
export function selectMacPhysicalAudioDevice(listing: string): string | undefined {
  return listMacAudioDevices(listing).find((d) => !d.virtual)?.device;
}

/** The loopback device that carries system (remote-participant) audio, if any. */
export function selectMacSystemAudioDevice(listing: string): string | undefined {
  const virtual = listMacAudioDevices(listing).filter((d) => d.virtual);
  for (const re of MAC_SYSTEM_AUDIO_PRIORITY) {
    const hit = virtual.find((d) => re.test(d.name));
    if (hit) return hit.device;
  }
  return virtual[0]?.device;
}

/** Resolve a logical source to the avfoundation device(s) to open; throws when it cannot. */
export function resolveMacCaptureSource(listing: string, source: MicCaptureSource): string[] {
  const mic = selectMacPhysicalAudioDevice(listing);
  const system = selectMacSystemAudioDevice(listing);
  if ((source === 'mic' || source === 'both') && !mic) {
    throw new Error('[mic-capture] no physical microphone found — pass --device explicitly');
  }
  if ((source === 'system' || source === 'both') && !system) {
    throw new Error(
      '[mic-capture] no loopback device (BlackHole etc.) found — system audio cannot be captured'
    );
  }
  if (source === 'mic') return [mic as string];
  if (source === 'system') return [system as string];
  return [mic as string, system as string];
}

export type MeetingShape = 'room' | 'remote' | 'hybrid';

/** Which capture source fits the meeting: room voices reach the mic, remote voices the speaker. */
export function recommendCaptureSource(shape: MeetingShape): MicCaptureSource {
  if (shape === 'room') return 'mic';
  if (shape === 'remote') return 'system';
  return 'both';
}

/**
 * Root-mean-square level of a PCM_S16LE buffer, 0..1. Used to tell a silent
 * capture (wrong source, muted bus) from a quiet room.
 */
export function pcmRms(payload: Uint8Array): number {
  const samples = Math.floor(payload.byteLength / 2);
  if (samples === 0) return 0;
  const view = new DataView(payload.buffer, payload.byteOffset, samples * 2);
  let sum = 0;
  for (let i = 0; i < samples; i += 1) {
    const v = view.getInt16(i * 2, true) / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / samples);
}

/** ffmpeg's avfoundation device listing (it exits non-zero by design; the list is on stderr). */
export function detectMacAudioListing(): string {
  const probe = spawnSync(
    resolveFfmpegBin(),
    ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  );
  return `${probe.stdout || ''}\n${probe.stderr || ''}`;
}

function detectMacPhysicalAudioDevice(): string | undefined {
  return selectMacPhysicalAudioDevice(detectMacAudioListing());
}

/** Resolve a host-safe default while preserving explicit test/device overrides. */
export function resolveMicDevice(explicit?: string): string {
  return resolveMicCaptureAdapter(process.platform).resolveDevice(explicit);
}

/**
 * Devices to open for an explicit device or a logical source. An explicit
 * `device` is always a single input, verbatim; combining it with `source` is
 * ambiguous and rejected.
 */
export function resolveCaptureDevices(device?: string, source?: MicCaptureSource): string[] {
  if (source && device?.trim()) {
    throw new Error('[mic-capture] pass either a device or a source, not both');
  }
  const adapter = resolveMicCaptureAdapter(process.platform);
  if (source) {
    if (!adapter.resolveSource) {
      throw new Error(
        `[mic-capture] source "${source}" is supported on macOS only — pass a device`
      );
    }
    return adapter.resolveSource(source);
  }
  return [adapter.resolveDevice(device)];
}

/** The ffmpeg/arecord argv for the given devices on `platform` (exported for tests). */
export function buildCaptureCommand(
  devices: string[],
  sampleRateHz: number,
  platform: NodeJS.Platform = process.platform
): string[] {
  return resolveMicCaptureAdapter(platform).command(devices, sampleRateHz);
}

export function probeMicCapture(opts: MicCaptureOptions = {}): MicCaptureProbeResult {
  if (opts.command?.length) return { available: true, backend: 'custom' };
  const adapter = resolveMicCaptureAdapter(process.platform);
  const binary = adapter.binary;
  const probe = spawnSync(binary, ['-version'], { stdio: 'ignore' });
  if (probe.error || probe.status === null) {
    return {
      available: false,
      backend: 'none',
      reason: `${binary} is not available on PATH — install it to enable microphone capture`,
    };
  }
  return {
    available: true,
    backend: adapter.backend,
  };
}

export async function startMicCapture(opts: MicCaptureOptions = {}): Promise<MicCaptureSession> {
  const sampleRateHz = opts.sampleRateHz ?? 16_000;
  const chunkMs = opts.chunkMs ?? 100;
  const bytesPerChunk = Math.max(2, Math.floor((sampleRateHz * 2 * chunkMs) / 1000));

  const argv =
    opts.command && opts.command.length > 0
      ? opts.command
      : buildCaptureCommand(resolveCaptureDevices(opts.device, opts.source), sampleRateHz);

  const child: ChildProcessWithoutNullStreams = spawn(argv[0], argv.slice(1), {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderrTail = '';
  child.stderr.on('data', (data: Buffer) => {
    stderrTail = `${stderrTail}${data.toString()}`.slice(-2000);
  });

  const startedAt = Date.now();
  let stopped = false;
  let pending = Buffer.alloc(0);
  const queue: AudioChunk[] = [];
  let notify: (() => void) | null = null;
  let ended = false;
  let spawnError: Error | null = null;

  const wake = () => {
    notify?.();
    notify = null;
  };

  child.on('error', (error) => {
    spawnError = error instanceof Error ? error : new Error(String(error));
    ended = true;
    wake();
  });
  child.stdout.on('data', (data: Buffer) => {
    pending = Buffer.concat([pending, data]);
    while (pending.length >= bytesPerChunk) {
      const payload = pending.subarray(0, bytesPerChunk);
      pending = pending.subarray(bytesPerChunk);
      queue.push({
        format: { encoding: 'pcm_s16le', sample_rate_hz: sampleRateHz, channels: 1 },
        payload: new Uint8Array(payload),
        ts_ms: Date.now() - startedAt,
      });
    }
    wake();
  });
  child.on('close', () => {
    if (pending.length > 0) {
      queue.push({
        format: { encoding: 'pcm_s16le', sample_rate_hz: sampleRateHz, channels: 1 },
        payload: new Uint8Array(pending),
        ts_ms: Date.now() - startedAt,
      });
      pending = Buffer.alloc(0);
    }
    ended = true;
    wake();
  });

  async function* iterate(): AsyncIterable<AudioChunk> {
    for (;;) {
      if (queue.length > 0) {
        yield queue.shift() as AudioChunk;
        continue;
      }
      if (spawnError && !stopped) {
        throw new Error(
          `[mic-capture] ${argv[0]} failed: ${spawnError.message}${stderrTail ? ` — ${stderrTail.trim()}` : ''}`
        );
      }
      if (ended) return;
      await new Promise<void>((resolve) => {
        notify = resolve;
      });
    }
  }

  return {
    chunks: iterate,
    stop: async () => {
      stopped = true;
      if (!ended) {
        child.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            child.kill('SIGKILL');
            resolve();
          }, 1500);
          child.once('close', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    },
  };
}
