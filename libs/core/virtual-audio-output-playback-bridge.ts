import * as path from 'node:path';
import { safeExec, safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';
import { pathResolver } from './path-resolver.js';
import type { AudioChunk, AudioFormat } from './meeting-session-types.js';
import { createVirtualDeviceInventoryBridge, type VirtualDeviceInventoryBridge } from './virtual-device-inventory-bridge.js';

export const VIRTUAL_AUDIO_OUTPUT_PLAYBACK_BRIDGE_ID = 'virtual-audio-output-playback-bridge' as const;

export interface VirtualAudioOutputPlaybackBridgeOptions {
  inventory_bridge?: VirtualDeviceInventoryBridge;
  swift_bin?: string;
  tone_frequency_hz?: number;
  tone_duration_ms?: number;
  tone_volume?: number;
}

export interface VirtualAudioOutputPlaybackRequest {
  source_path?: string;
}

export interface VirtualAudioOutputPlaybackTargetResult {
  device_name: string;
  status: 'played' | 'failed' | 'skipped';
  source_path: string;
  tone_path: string;
  selected_backend: 'swift-output-switch';
  output?: string;
  error?: string;
}

export interface VirtualAudioOutputPlaybackProbe {
  bridge_id: typeof VIRTUAL_AUDIO_OUTPUT_PLAYBACK_BRIDGE_ID;
  platform: NodeJS.Platform;
  available: boolean;
  reason?: string;
  outputs: string[];
}

export interface VirtualAudioOutputPlaybackBridge {
  readonly bridge_id: typeof VIRTUAL_AUDIO_OUTPUT_PLAYBACK_BRIDGE_ID;
  probe(): Promise<VirtualAudioOutputPlaybackProbe>;
  playOnOutputs(
    targets?: string[],
    request?: VirtualAudioOutputPlaybackRequest,
  ): Promise<{ bridge_id: typeof VIRTUAL_AUDIO_OUTPUT_PLAYBACK_BRIDGE_ID; platform: NodeJS.Platform; outputs: VirtualAudioOutputPlaybackTargetResult[] }>;
  playStream(
    stream: AsyncIterable<AudioChunk>,
    targets?: string[],
    request?: VirtualAudioOutputPlaybackRequest,
  ): Promise<{ bridge_id: typeof VIRTUAL_AUDIO_OUTPUT_PLAYBACK_BRIDGE_ID; platform: NodeJS.Platform; outputs: VirtualAudioOutputPlaybackTargetResult[] }>;
}

const DEFAULT_SWIFT_BIN = 'swift';
const DEFAULT_TONE_FREQUENCY_HZ = 880;
const DEFAULT_TONE_DURATION_MS = 300;
const DEFAULT_TONE_VOLUME = 0.18;
const DEFAULT_TONE_DIR = path.join('audio-output-tests');

function tonePathFor(deviceName: string): string {
  const safeName = deviceName.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'output';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(DEFAULT_TONE_DIR, `${safeName}-${stamp}.wav`);
}

function writeSineToneWav(
  outputPath: string,
  opts: { frequencyHz: number; durationMs: number; volume: number },
): void {
  const sampleRate = 44100;
  const channels = 1;
  const bitsPerSample = 16;
  const frameCount = Math.max(1, Math.floor(sampleRate * (opts.durationMs / 1000)));
  const dataSize = frameCount * channels * (bitsPerSample / 8);
  const buffer = Buffer.alloc(44 + dataSize);

  const writeString = (offset: number, value: string) => buffer.write(value, offset, 'ascii');
  const writeUInt32LE = (offset: number, value: number) => buffer.writeUInt32LE(value, offset);
  const writeUInt16LE = (offset: number, value: number) => buffer.writeUInt16LE(value, offset);

  writeString(0, 'RIFF');
  writeUInt32LE(4, 36 + dataSize);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  writeUInt32LE(16, 16);
  writeUInt16LE(20, 1);
  writeUInt16LE(22, channels);
  writeUInt32LE(24, sampleRate);
  writeUInt32LE(28, sampleRate * channels * (bitsPerSample / 8));
  writeUInt16LE(32, channels * (bitsPerSample / 8));
  writeUInt16LE(34, bitsPerSample);
  writeString(36, 'data');
  writeUInt32LE(40, dataSize);

  const amplitude = Math.max(0, Math.min(1, opts.volume)) * 0x7fff;
  let offset = 44;
  for (let i = 0; i < frameCount; i += 1) {
    const sample = Math.round(amplitude * Math.sin((2 * Math.PI * opts.frequencyHz * i) / sampleRate));
    buffer.writeInt16LE(sample, offset);
    offset += 2;
  }

  safeMkdir(path.dirname(outputPath), { recursive: true });
  safeWriteFile(outputPath, buffer);
}

function writeWavFromChunks(
  outputPath: string,
  chunks: AudioChunk[],
  format: AudioFormat,
): void {
  if (format.encoding !== 'pcm_s16le') {
    throw new Error(`[virtual-audio-output-playback-bridge] unsupported stream encoding ${format.encoding}`);
  }
  const channels = format.channels;
  const sampleRate = format.sample_rate_hz;
  const bitsPerSample = 16;
  const dataSize = chunks.reduce((total, chunk) => total + chunk.payload.byteLength, 0);
  const buffer = Buffer.alloc(44 + dataSize);

  const writeString = (offset: number, value: string) => buffer.write(value, offset, 'ascii');
  const writeUInt32LE = (offset: number, value: number) => buffer.writeUInt32LE(value, offset);
  const writeUInt16LE = (offset: number, value: number) => buffer.writeUInt16LE(value, offset);

  writeString(0, 'RIFF');
  writeUInt32LE(4, 36 + dataSize);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  writeUInt32LE(16, 16);
  writeUInt16LE(20, 1);
  writeUInt16LE(22, channels);
  writeUInt32LE(24, sampleRate);
  writeUInt32LE(28, sampleRate * channels * (bitsPerSample / 8));
  writeUInt16LE(32, channels * (bitsPerSample / 8));
  writeUInt16LE(34, bitsPerSample);
  writeString(36, 'data');
  writeUInt32LE(40, dataSize);

  let offset = 44;
  for (const chunk of chunks) {
    const data = Buffer.from(chunk.payload);
    data.copy(buffer, offset);
    offset += data.byteLength;
  }

  safeMkdir(path.dirname(outputPath), { recursive: true });
  safeWriteFile(outputPath, buffer);
}

export class VirtualAudioOutputPlaybackBridgeImpl implements VirtualAudioOutputPlaybackBridge {
  readonly bridge_id = VIRTUAL_AUDIO_OUTPUT_PLAYBACK_BRIDGE_ID;
  private readonly inventoryBridge: VirtualDeviceInventoryBridge;

  constructor(private readonly opts: VirtualAudioOutputPlaybackBridgeOptions = {}) {
    this.inventoryBridge = opts.inventory_bridge ?? createVirtualDeviceInventoryBridge();
  }

  async probe(): Promise<VirtualAudioOutputPlaybackProbe> {
    const inventory = await this.inventoryBridge.probe();
    const outputs = inventory.inventory.audio_outputs.map((output) => output.name);
    return {
      bridge_id: VIRTUAL_AUDIO_OUTPUT_PLAYBACK_BRIDGE_ID,
      platform: process.platform,
      available: process.platform === 'darwin' && outputs.length > 0,
      reason: process.platform !== 'darwin' ? `unsupported platform ${process.platform}` : outputs.length === 0 ? 'no audio outputs found' : undefined,
      outputs,
    };
  }

  async playOnOutputs(targets?: string[], request?: VirtualAudioOutputPlaybackRequest): Promise<{
    bridge_id: typeof VIRTUAL_AUDIO_OUTPUT_PLAYBACK_BRIDGE_ID;
    platform: NodeJS.Platform;
    outputs: VirtualAudioOutputPlaybackTargetResult[];
  }> {
    const probe = await this.probe();
    if (!probe.available) {
      throw new Error(`[virtual-audio-output-playback-bridge] not available: ${probe.reason || 'unknown reason'}`);
    }

    const inventory = await this.inventoryBridge.probe();
    const selectedOutputs = (targets && targets.length > 0 ? targets : probe.outputs)
      .map((name) => name.trim())
      .filter(Boolean);
    if (selectedOutputs.length === 0) {
      return {
        bridge_id: VIRTUAL_AUDIO_OUTPUT_PLAYBACK_BRIDGE_ID,
        platform: process.platform,
        outputs: [],
      };
    }

    const playbackPath = request?.source_path
      ? pathResolver.rootResolve(request.source_path)
      : pathResolver.sharedTmp(tonePathFor(selectedOutputs[0]));
    if (!request?.source_path) {
      writeSineToneWav(playbackPath, {
        frequencyHz: this.opts.tone_frequency_hz ?? DEFAULT_TONE_FREQUENCY_HZ,
        durationMs: this.opts.tone_duration_ms ?? DEFAULT_TONE_DURATION_MS,
        volume: this.opts.tone_volume ?? DEFAULT_TONE_VOLUME,
      });
    }

    const results: VirtualAudioOutputPlaybackTargetResult[] = [];
    const swiftBin = this.opts.swift_bin ?? DEFAULT_SWIFT_BIN;
    const script = pathResolver.rootResolve('libs/core/virtual-audio-output-playback.swift');

    for (const outputName of selectedOutputs) {
      const candidate = inventory.inventory.audio_outputs.find((device) => device.name === outputName);
      if (!candidate) {
        results.push({
          device_name: outputName,
          status: 'skipped',
          source_path: playbackPath,
          tone_path: playbackPath,
          selected_backend: 'swift-output-switch',
          error: 'output device not found in inventory',
        });
        continue;
      }
      try {
        const output = safeExec(
          swiftBin,
          [script, '--device', candidate.name, '--tone-path', playbackPath],
          { env: process.env, timeoutMs: 120000 },
        );
        results.push({
          device_name: candidate.name,
          status: 'played',
          source_path: playbackPath,
          tone_path: playbackPath,
          selected_backend: 'swift-output-switch',
          output: output.trim() || undefined,
        });
      } catch (error: any) {
        results.push({
          device_name: candidate.name,
          status: 'failed',
          source_path: playbackPath,
          tone_path: playbackPath,
          selected_backend: 'swift-output-switch',
          error: error?.message || String(error),
        });
      }
    }

    if (!request?.source_path) {
      safeRmSync(playbackPath, { force: true });
    }

    return {
      bridge_id: VIRTUAL_AUDIO_OUTPUT_PLAYBACK_BRIDGE_ID,
      platform: process.platform,
      outputs: results,
    };
  }

  async playStream(
    stream: AsyncIterable<AudioChunk>,
    targets?: string[],
    request?: VirtualAudioOutputPlaybackRequest,
  ): Promise<{
    bridge_id: typeof VIRTUAL_AUDIO_OUTPUT_PLAYBACK_BRIDGE_ID;
    platform: NodeJS.Platform;
    outputs: VirtualAudioOutputPlaybackTargetResult[];
  }> {
    const chunks: AudioChunk[] = [];
    let streamFormat: AudioFormat | undefined;
    for await (const chunk of stream) {
      if (!streamFormat) streamFormat = chunk.format;
      if (streamFormat.encoding !== chunk.format.encoding
        || streamFormat.channels !== chunk.format.channels
        || streamFormat.sample_rate_hz !== chunk.format.sample_rate_hz) {
        throw new Error('[virtual-audio-output-playback-bridge] mixed audio stream formats are not supported');
      }
      chunks.push(chunk);
    }
    if (!streamFormat) {
      return {
        bridge_id: VIRTUAL_AUDIO_OUTPUT_PLAYBACK_BRIDGE_ID,
        platform: process.platform,
        outputs: [],
      };
    }

    const tempPath = pathResolver.sharedTmp(tonePathFor('streamed-output'));
    writeWavFromChunks(tempPath, chunks, streamFormat);
    try {
      return await this.playOnOutputs(targets, { ...(request || {}), source_path: tempPath });
    } finally {
      safeRmSync(tempPath, { force: true });
    }
  }
}

export function createVirtualAudioOutputPlaybackBridge(
  opts: VirtualAudioOutputPlaybackBridgeOptions = {},
): VirtualAudioOutputPlaybackBridge {
  return new VirtualAudioOutputPlaybackBridgeImpl(opts);
}
