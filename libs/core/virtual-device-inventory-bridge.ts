import { safeExecResult } from './secure-io.js';

export const VIRTUAL_DEVICE_INVENTORY_BRIDGE_ID = 'virtual-device-inventory-bridge' as const;

export type VirtualDeviceKind = 'audio-input' | 'audio-output' | 'camera' | 'virtual-audio' | 'virtual-camera';

export interface VirtualDeviceRecord {
  kind: VirtualDeviceKind;
  name: string;
  platform: NodeJS.Platform;
  source: 'system_profiler' | 'ffmpeg' | 'pactl' | 'imagesnap' | 'heuristic';
  available: boolean;
  details?: Record<string, unknown>;
}

export interface VirtualDeviceInventory {
  audio_inputs: VirtualDeviceRecord[];
  audio_outputs: VirtualDeviceRecord[];
  cameras: VirtualDeviceRecord[];
  virtual_audio_devices: VirtualDeviceRecord[];
  virtual_cameras: VirtualDeviceRecord[];
  notes: string[];
}

export interface VirtualDeviceInventoryProbe {
  bridge_id: typeof VIRTUAL_DEVICE_INVENTORY_BRIDGE_ID;
  platform: NodeJS.Platform;
  available: boolean;
  reason?: string;
  inventory: VirtualDeviceInventory;
}

export interface VirtualDeviceInventoryBridge {
  readonly bridge_id: typeof VIRTUAL_DEVICE_INVENTORY_BRIDGE_ID;
  probe(): Promise<VirtualDeviceInventoryProbe>;
  scan(): Promise<VirtualDeviceInventory>;
}

export interface VirtualDeviceInventoryOptions {
  system_profiler_bin?: string;
  ffmpeg_bin?: string;
  pactl_bin?: string;
  imagesnap_bin?: string;
  command_runner?: (command: string, args: string[]) => {
    stdout: string;
    stderr: string;
    status: number | null;
    error?: Error;
  };
}

const DEFAULT_SYSTEM_PROFILER = 'system_profiler';
const DEFAULT_FFMPEG = 'ffmpeg';
const DEFAULT_PACTL = 'pactl';
const DEFAULT_IMAGESNAP = 'imagesnap';

function emptyInventory(): VirtualDeviceInventory {
  return {
    audio_inputs: [],
    audio_outputs: [],
    cameras: [],
    virtual_audio_devices: [],
    virtual_cameras: [],
    notes: [],
  };
}

function uniqueByName(records: VirtualDeviceRecord[]): VirtualDeviceRecord[] {
  const seen = new Set<string>();
  return records.filter((record) => {
    const key = `${record.kind}:${record.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function tryParseJson(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function runCommand(
  opts: VirtualDeviceInventoryOptions,
  command: string,
  args: string[],
): { stdout: string; stderr: string; status: number | null; error?: Error } {
  if (opts.command_runner) return opts.command_runner(command, args);
  return safeExecResult(command, args, { maxOutputMB: 5 });
}

function collectMacAudioDevices(
  opts: VirtualDeviceInventoryOptions,
  bin: string,
): VirtualDeviceRecord[] {
  const result = runCommand(opts, bin, ['SPAudioDataType', '-json']);
  const records: VirtualDeviceRecord[] = [];
  const payload = tryParseJson(result.stdout);
  const sections = Array.isArray((payload as any)?.SPAudioDataType) ? (payload as any).SPAudioDataType : [];
  for (const section of sections) {
    for (const device of Array.isArray(section?._items) ? section._items : []) {
      const name = String(device?._name || device?.coreaudio_device_name || '').trim();
      if (!name) continue;
      const hasInput = Boolean(device?.coreaudio_default_audio_input_device || device?.coreaudio_input_source);
      const hasOutput = Boolean(device?.coreaudio_default_audio_output_device || device?.coreaudio_output_source);
      const isVirtual = /blackhole|loopback|meeting_in|meeting_out|pulse/i.test(name);
      const base: VirtualDeviceRecord = {
        kind: hasInput && !hasOutput ? 'audio-input' : hasOutput && !hasInput ? 'audio-output' : 'audio-input',
        name,
        platform: process.platform,
        source: 'system_profiler',
        available: true,
        details: {
          model: device?._model || device?.coreaudio_device_transport || undefined,
        },
      };
      records.push(base);
      if (hasOutput) {
        records.push({ ...base, kind: 'audio-output' });
      }
      if (hasInput) {
        records.push({ ...base, kind: 'audio-input' });
      }
      if (isVirtual) {
        records.push({ ...base, kind: 'virtual-audio' });
      }
    }
  }
  return uniqueByName(records);
}

function collectMacCameraDevices(
  opts: VirtualDeviceInventoryOptions,
  systemProfilerBin: string,
  ffmpegBin: string,
): VirtualDeviceRecord[] {
  const records: VirtualDeviceRecord[] = [];
  const sp = runCommand(opts, systemProfilerBin, ['SPCameraDataType', '-json']);
  const payload = tryParseJson(sp.stdout);
  const sections = Array.isArray((payload as any)?.SPCameraDataType) ? (payload as any).SPCameraDataType : [];
  for (const section of sections) {
    for (const device of Array.isArray(section?._items) ? section._items : []) {
      const name = String(device?._name || device?.coremediaio_dal_device_name || '').trim();
      if (!name) continue;
      records.push({
        kind: 'camera',
        name,
        platform: process.platform,
        source: 'system_profiler',
        available: true,
        details: {
          model: device?._model || undefined,
        },
      });
    }
  }

  if (records.length === 0) {
    const result = runCommand(opts, ffmpegBin, ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', '""']);
    const text = `${result.stdout}\n${result.stderr}`;
    const lines = text.split('\n');
    let section: 'audio' | 'video' | null = null;
    for (const line of lines) {
      if (/AVFoundation video devices/i.test(line)) {
        section = 'video';
        continue;
      }
      if (/AVFoundation audio devices/i.test(line)) {
        section = 'audio';
        continue;
      }
      const match = line.match(/\[\s*\d+\]\s*(.+?)\s*(?:\((video|audio)\))?\s*$/);
      if (!match) continue;
      const name = match[1].trim();
      if (!name) continue;
      if (section === 'video') {
        records.push({
          kind: 'camera',
          name,
          platform: process.platform,
          source: 'ffmpeg',
          available: true,
        });
      } else if (section === 'audio') {
        records.push({
          kind: 'audio-input',
          name,
          platform: process.platform,
          source: 'ffmpeg',
          available: true,
        });
        records.push({
          kind: 'audio-output',
          name,
          platform: process.platform,
          source: 'ffmpeg',
          available: true,
        });
      }
    }
  }

  const virtualSource = records.find((record) => /blackhole|loopback|virtual/i.test(record.name));
  if (virtualSource) {
    records.push({
      kind: 'virtual-camera',
      name: virtualSource.name,
      platform: process.platform,
      source: virtualSource.source,
      available: true,
      details: virtualSource.details,
    });
  }

  return uniqueByName(records);
}

function collectLinuxAudioDevices(
  opts: VirtualDeviceInventoryOptions,
  bin: string,
): VirtualDeviceRecord[] {
  const result = runCommand(opts, bin, ['list', 'short', 'sources']);
  const sourcesText = result.stdout || result.stderr;
  const records: VirtualDeviceRecord[] = [];
  for (const line of sourcesText.split('\n')) {
    const parts = line.trim().split(/\s+/);
    const name = parts[1];
    if (!name) continue;
    records.push({
      kind: /monitor|source/i.test(name) ? 'audio-input' : 'audio-input',
      name,
      platform: process.platform,
      source: 'pactl',
      available: true,
    });
    if (/monitor|null/i.test(name)) {
      records.push({
        kind: 'virtual-audio',
        name,
        platform: process.platform,
        source: 'pactl',
        available: true,
      });
    }
  }

  const sinks = runCommand(opts, bin, ['list', 'short', 'sinks']);
  const sinksText = sinks.stdout || sinks.stderr;
  for (const line of sinksText.split('\n')) {
    const parts = line.trim().split(/\s+/);
    const name = parts[1];
    if (!name) continue;
    records.push({
      kind: 'audio-output',
      name,
      platform: process.platform,
      source: 'pactl',
      available: true,
    });
    if (/monitor|null/i.test(name)) {
      records.push({
        kind: 'virtual-audio',
        name,
        platform: process.platform,
        source: 'pactl',
        available: true,
      });
    }
  }
  return uniqueByName(records);
}

function collectLinuxCameraDevices(
  opts: VirtualDeviceInventoryOptions,
  bin: string,
): VirtualDeviceRecord[] {
  const result = runCommand(opts, bin, ['-hide_banner', '-f', 'v4l2', '-list_devices', 'true', '-i', '""']);
  const text = `${result.stdout}\n${result.stderr}`;
  const records: VirtualDeviceRecord[] = [];
  for (const line of text.split('\n')) {
    const match = line.match(/\[(?:video4linux2|v4l2|dshow|avfoundation).*?\]\s*(.+)$/i);
    const name = match?.[1]?.trim();
    if (!name) continue;
    records.push({
      kind: 'camera',
      name,
      platform: process.platform,
      source: 'ffmpeg',
      available: true,
    });
  }
  return uniqueByName(records);
}

export class VirtualDeviceInventoryBridgeImpl implements VirtualDeviceInventoryBridge {
  readonly bridge_id = VIRTUAL_DEVICE_INVENTORY_BRIDGE_ID;

  constructor(private readonly opts: VirtualDeviceInventoryOptions = {}) {}

  async scan(): Promise<VirtualDeviceInventory> {
    const inventory = emptyInventory();

    if (process.platform === 'darwin') {
      const audioBin = this.opts.system_profiler_bin ?? DEFAULT_SYSTEM_PROFILER;
      const ffmpegBin = this.opts.ffmpeg_bin ?? DEFAULT_FFMPEG;
      const imagesnapBin = this.opts.imagesnap_bin ?? DEFAULT_IMAGESNAP;

      const audio = collectMacAudioDevices(this.opts, audioBin);
      inventory.audio_inputs.push(...audio.filter((record) => record.kind === 'audio-input'));
      inventory.audio_outputs.push(...audio.filter((record) => record.kind === 'audio-output'));
      inventory.virtual_audio_devices.push(...audio.filter((record) => record.kind === 'virtual-audio'));

      const cameras = collectMacCameraDevices(this.opts, audioBin, ffmpegBin);
      inventory.cameras.push(...cameras.filter((record) => record.kind === 'camera'));
      inventory.virtual_cameras.push(...cameras.filter((record) => record.kind === 'virtual-camera'));

      if (cameras.length === 0) {
        const probe = runCommand(this.opts, imagesnapBin, ['-h']);
        if (probe.status === 0 || !probe.error) {
          inventory.notes.push('imagesnap available but no camera was listed by ffmpeg avfoundation probe');
        } else {
          inventory.notes.push(`imagesnap probe failed: ${probe.stderr || probe.stdout || 'unknown reason'}`);
        }
      }
    } else if (process.platform === 'linux') {
      const pactlBin = this.opts.pactl_bin ?? DEFAULT_PACTL;
      const ffmpegBin = this.opts.ffmpeg_bin ?? DEFAULT_FFMPEG;
      const audio = collectLinuxAudioDevices(this.opts, pactlBin);
      inventory.audio_inputs.push(...audio.filter((record) => record.kind === 'audio-input'));
      inventory.audio_outputs.push(...audio.filter((record) => record.kind === 'audio-output'));
      inventory.virtual_audio_devices.push(...audio.filter((record) => record.kind === 'virtual-audio'));
      inventory.cameras.push(...collectLinuxCameraDevices(this.opts, ffmpegBin));
    } else {
      inventory.notes.push(`platform ${process.platform} has no built-in inventory probe; stub only`);
    }

    if (inventory.audio_inputs.length === 0 && inventory.audio_outputs.length === 0 && inventory.cameras.length === 0) {
      inventory.notes.push('no real devices discovered; bridge should fall back to stub');
    }

    return inventory;
  }

  async probe(): Promise<VirtualDeviceInventoryProbe> {
    const inventory = await this.scan();
    const available =
      inventory.audio_inputs.length > 0 ||
      inventory.audio_outputs.length > 0 ||
      inventory.cameras.length > 0 ||
      inventory.virtual_audio_devices.length > 0 ||
      inventory.virtual_cameras.length > 0;
    return {
      bridge_id: VIRTUAL_DEVICE_INVENTORY_BRIDGE_ID,
      platform: process.platform,
      available,
      reason: available ? undefined : inventory.notes[0],
      inventory,
    };
  }
}

export function createVirtualDeviceInventoryBridge(
  opts: VirtualDeviceInventoryOptions = {},
): VirtualDeviceInventoryBridge {
  return new VirtualDeviceInventoryBridgeImpl(opts);
}
