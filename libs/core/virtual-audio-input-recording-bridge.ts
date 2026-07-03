/* eslint-disable no-restricted-imports -- IP-08 で managed-process 経由へ移行予定 (docs/improvement-plans-2026-07/IP-08_ERROR_HANDLING_DISCIPLINE.ja.md) */
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import {
  createVirtualDeviceInventoryBridge,
  type VirtualDeviceInventoryBridge,
} from './virtual-device-inventory-bridge.js';
import { pathResolver } from './path-resolver.js';
import type { AudioChunk, AudioFormat } from './meeting-session-types.js';
import { safeExec, safeExecResult, safeMkdir, safeWriteFile } from './secure-io.js';

export const VIRTUAL_AUDIO_INPUT_RECORDING_BRIDGE_ID =
  'virtual-audio-input-recording-bridge' as const;

export interface VirtualAudioInputRecordingBridgeOptions {
  inventory_bridge?: VirtualDeviceInventoryBridge;
  ffmpeg_bin?: string;
  sox_bin?: string;
}

export interface VirtualAudioInputRecordingRequest {
  duration_sec?: number;
  output_path?: string;
  prompt_text?: string;
}

export interface VirtualAudioInputRecordingTargetResult {
  device_name: string;
  status: 'recorded' | 'failed' | 'skipped';
  recorded_path: string;
  selected_backend: 'ffmpeg-avfoundation' | 'sox-default-input';
  device_index?: number;
  output?: string;
  error?: string;
}

export interface VirtualAudioInputRecordingProbe {
  bridge_id: typeof VIRTUAL_AUDIO_INPUT_RECORDING_BRIDGE_ID;
  platform: NodeJS.Platform;
  available: boolean;
  reason?: string;
  inputs: string[];
}

export interface VirtualAudioInputRecordingBridge {
  readonly bridge_id: typeof VIRTUAL_AUDIO_INPUT_RECORDING_BRIDGE_ID;
  probe(): Promise<VirtualAudioInputRecordingProbe>;
  captureStream(
    target?: string,
    request?: VirtualAudioInputRecordingRequest
  ): AsyncIterable<AudioChunk>;
  recordOnInputs(
    targets?: string[],
    request?: VirtualAudioInputRecordingRequest
  ): Promise<{
    bridge_id: typeof VIRTUAL_AUDIO_INPUT_RECORDING_BRIDGE_ID;
    platform: NodeJS.Platform;
    recordings: VirtualAudioInputRecordingTargetResult[];
  }>;
}

const DEFAULT_FFMPEG_BIN = 'ffmpeg';
const DEFAULT_SOX_BIN = 'sox';
const DEFAULT_STREAM_FORMAT: AudioFormat = {
  encoding: 'pcm_s16le',
  sample_rate_hz: 16000,
  channels: 1,
};

function safeSlug(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'input';
}

function resolveRecordingPath(deviceName: string, requestedPath?: string): string {
  if (typeof requestedPath === 'string' && requestedPath.trim()) {
    return pathResolver.rootResolve(requestedPath.trim());
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return pathResolver.sharedTmp(
    path.join('audio-input-recordings', `${safeSlug(deviceName)}-${stamp}.wav`)
  );
}

function parseFfmpegAudioInputs(
  stdout: string,
  stderr: string
): Array<{ index: number; name: string }> {
  const text = `${stdout}\n${stderr}`;
  const lines = text.split('\n');
  const inputs: Array<{ index: number; name: string }> = [];
  let inAudioSection = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (/AVFoundation audio devices/i.test(line)) {
      inAudioSection = true;
      continue;
    }
    if (/AVFoundation video devices/i.test(line)) {
      inAudioSection = false;
      continue;
    }
    if (!inAudioSection) continue;
    const match = line.match(/\[(\d+)\]\s*(.+)$/);
    if (!match) continue;
    const index = Number(match[1]);
    const name = match[2].trim();
    if (!Number.isFinite(index) || !name) continue;
    inputs.push({ index, name });
  }
  return inputs;
}

function pickInputIndex(
  candidates: Array<{ index: number; name: string }>,
  preference?: string
): { index: number; name: string } | undefined {
  if (candidates.length === 0) return undefined;
  const normalized = typeof preference === 'string' ? preference.trim().toLowerCase() : '';
  if (!normalized) return candidates[0];
  const exact = candidates.find((candidate) => candidate.name.trim().toLowerCase() === normalized);
  if (exact) return exact;
  const contains = candidates.find((candidate) =>
    candidate.name.trim().toLowerCase().includes(normalized)
  );
  if (contains) return contains;
  return candidates[0];
}

async function collectStreamInputIndex(
  inventoryBridge: VirtualDeviceInventoryBridge,
  target?: string
): Promise<{ name: string; index: number } | undefined> {
  const inventory = await inventoryBridge.probe();
  const selectedName =
    target && target.trim() ? target.trim() : inventory.inventory.audio_inputs[0]?.name;
  if (!selectedName) return undefined;
  const ffmpegList = safeExecResult(
    'ffmpeg',
    ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', '""'],
    { maxOutputMB: 5 }
  );
  const ffmpegInputs = parseFfmpegAudioInputs(ffmpegList.stdout, ffmpegList.stderr);
  return pickInputIndex(ffmpegInputs, selectedName);
}

export class VirtualAudioInputRecordingBridgeImpl implements VirtualAudioInputRecordingBridge {
  readonly bridge_id = VIRTUAL_AUDIO_INPUT_RECORDING_BRIDGE_ID;
  private readonly inventoryBridge: VirtualDeviceInventoryBridge;

  constructor(private readonly opts: VirtualAudioInputRecordingBridgeOptions = {}) {
    this.inventoryBridge = opts.inventory_bridge ?? createVirtualDeviceInventoryBridge();
  }

  async probe(): Promise<VirtualAudioInputRecordingProbe> {
    const inventory = await this.inventoryBridge.probe();
    const inputs = inventory.inventory.audio_inputs.map((input) => input.name);
    return {
      bridge_id: VIRTUAL_AUDIO_INPUT_RECORDING_BRIDGE_ID,
      platform: process.platform,
      available: process.platform === 'darwin' && inputs.length > 0,
      reason:
        process.platform !== 'darwin'
          ? `unsupported platform ${process.platform}`
          : inputs.length === 0
            ? 'no audio inputs found'
            : undefined,
      inputs,
    };
  }

  async *captureStream(
    target?: string,
    request: VirtualAudioInputRecordingRequest = {}
  ): AsyncIterable<AudioChunk> {
    if (process.platform !== 'darwin') {
      throw new Error(
        `[virtual-audio-input-recording-bridge] stream capture unsupported on ${process.platform}`
      );
    }

    const durationSec = Number(request.duration_sec || 0) > 0 ? Number(request.duration_sec) : 3;
    const selected = await collectStreamInputIndex(this.inventoryBridge, target);
    if (!selected) {
      throw new Error(
        '[virtual-audio-input-recording-bridge] no audio input available for stream capture'
      );
    }

    const ffmpegBin = this.opts.ffmpeg_bin ?? DEFAULT_FFMPEG_BIN;
    const child = spawn(
      ffmpegBin,
      [
        '-y',
        '-hide_banner',
        '-f',
        'avfoundation',
        '-i',
        `:${selected.index}`,
        '-ac',
        String(DEFAULT_STREAM_FORMAT.channels),
        '-ar',
        String(DEFAULT_STREAM_FORMAT.sample_rate_hz),
        '-f',
        's16le',
        '-t',
        String(durationSec),
        'pipe:1',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    let tsMs = 0;
    try {
      for await (const chunk of child.stdout) {
        const payload = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        yield {
          format: DEFAULT_STREAM_FORMAT,
          payload: new Uint8Array(payload),
          ts_ms: tsMs,
        };
        const bytesPerMs =
          (DEFAULT_STREAM_FORMAT.sample_rate_hz * DEFAULT_STREAM_FORMAT.channels * 2) / 1000;
        tsMs += Math.max(1, Math.round(payload.byteLength / bytesPerMs));
      }
      const exitCode: number = await new Promise((resolve) => {
        child.once('close', (code) => resolve(code ?? 0));
      });
      if (exitCode !== 0) {
        throw new Error(stderr.trim() || `ffmpeg exited with code ${exitCode}`);
      }
    } catch (error: any) {
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
      throw new Error(
        `[virtual-audio-input-recording-bridge] stream capture failed: ${error?.message || String(error)}`
      );
    }
  }

  async recordOnInputs(
    targets?: string[],
    request: VirtualAudioInputRecordingRequest = {}
  ): Promise<{
    bridge_id: typeof VIRTUAL_AUDIO_INPUT_RECORDING_BRIDGE_ID;
    platform: NodeJS.Platform;
    recordings: VirtualAudioInputRecordingTargetResult[];
  }> {
    const probe = await this.probe();
    if (!probe.available) {
      throw new Error(
        `[virtual-audio-input-recording-bridge] not available: ${probe.reason || 'unknown reason'}`
      );
    }

    const inventory = await this.inventoryBridge.probe();
    const selectedInputs = (targets && targets.length > 0 ? targets : probe.inputs)
      .map((name) => name.trim())
      .filter(Boolean);
    if (selectedInputs.length === 0) {
      return {
        bridge_id: VIRTUAL_AUDIO_INPUT_RECORDING_BRIDGE_ID,
        platform: process.platform,
        recordings: [],
      };
    }

    const durationSec = Number(request.duration_sec || 0) > 0 ? Number(request.duration_sec) : 3;
    const results: VirtualAudioInputRecordingTargetResult[] = [];
    const ffmpegBin = this.opts.ffmpeg_bin ?? DEFAULT_FFMPEG_BIN;
    const soxBin = this.opts.sox_bin ?? DEFAULT_SOX_BIN;
    const ffmpegList = safeExecResult(
      ffmpegBin,
      ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', '""'],
      { maxOutputMB: 5 }
    );
    const ffmpegInputs = parseFfmpegAudioInputs(ffmpegList.stdout, ffmpegList.stderr);
    const candidateNames = new Set(inventory.inventory.audio_inputs.map((input) => input.name));

    for (const inputName of selectedInputs) {
      const candidate =
        inventory.inventory.audio_inputs.find((device) => device.name === inputName) ??
        inventory.inventory.audio_inputs.find((device) =>
          device.name.trim().toLowerCase().includes(inputName.toLowerCase())
        ) ??
        inventory.inventory.virtual_audio_devices.find((device) => device.name === inputName) ??
        inventory.inventory.virtual_audio_devices.find((device) =>
          device.name.trim().toLowerCase().includes(inputName.toLowerCase())
        );
      if (!candidate) {
        results.push({
          device_name: inputName,
          status: 'skipped',
          recorded_path: resolveRecordingPath(inputName, request.output_path),
          selected_backend: 'ffmpeg-avfoundation',
          error: 'input device not found in inventory',
        });
        continue;
      }

      const ffmpegCandidate =
        pickInputIndex(
          ffmpegInputs.filter((entry) => candidateNames.has(entry.name)),
          candidate.name
        ) ?? pickInputIndex(ffmpegInputs, candidate.name);
      const recordingPath = resolveRecordingPath(candidate.name, request.output_path);
      safeMkdir(path.dirname(recordingPath), { recursive: true });
      if (request.prompt_text) {
        const promptPath = `${recordingPath}.prompt.txt`;
        safeWriteFile(promptPath, `${request.prompt_text}\n`);
      }

      try {
        if (process.platform === 'darwin') {
          if (ffmpegCandidate) {
            const output = safeExec(
              ffmpegBin,
              [
                '-y',
                '-f',
                'avfoundation',
                '-i',
                `:${ffmpegCandidate.index}`,
                '-t',
                String(durationSec),
                '-ac',
                '1',
                '-ar',
                '16000',
                recordingPath,
              ],
              { timeoutMs: Math.max(30_000, durationSec * 1000 + 15_000) }
            );
            results.push({
              device_name: candidate.name,
              status: 'recorded',
              recorded_path: recordingPath,
              selected_backend: 'ffmpeg-avfoundation',
              device_index: ffmpegCandidate.index,
              output: output.trim() || undefined,
            });
            continue;
          }

          const output = safeExec(
            soxBin,
            ['-d', '-c', '1', '-r', '16000', recordingPath, 'trim', '0', String(durationSec)],
            { timeoutMs: Math.max(30_000, durationSec * 1000 + 15_000) }
          );
          results.push({
            device_name: candidate.name,
            status: 'recorded',
            recorded_path: recordingPath,
            selected_backend: 'sox-default-input',
            output: output.trim() || undefined,
          });
          continue;
        }

        results.push({
          device_name: candidate.name,
          status: 'skipped',
          recorded_path: recordingPath,
          selected_backend: 'ffmpeg-avfoundation',
          error: `unsupported platform ${process.platform}`,
        });
      } catch (error: any) {
        results.push({
          device_name: candidate.name,
          status: 'failed',
          recorded_path: recordingPath,
          selected_backend: 'ffmpeg-avfoundation',
          error: error?.message || String(error),
        });
      }
    }

    return {
      bridge_id: VIRTUAL_AUDIO_INPUT_RECORDING_BRIDGE_ID,
      platform: process.platform,
      recordings: results,
    };
  }
}

export function createVirtualAudioInputRecordingBridge(
  opts: VirtualAudioInputRecordingBridgeOptions = {}
): VirtualAudioInputRecordingBridge {
  return new VirtualAudioInputRecordingBridgeImpl(opts);
}
