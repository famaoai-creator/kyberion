import { safeExecResult } from './secure-io.js';
import { rootResolve } from './path-resolver.js';
import type { AudioDeviceDescriptor } from './audio-route.js';

export const COREAUDIO_DEVICE_INVENTORY_BRIDGE_ID = 'coreaudio-device-inventory' as const;

interface CommandResult {
  stdout: string;
  stderr: string;
  status: number | null;
  error?: Error;
}

export interface CoreAudioDeviceInventoryBridgeOptions {
  swift_bin?: string;
  script_path?: string;
  command_runner?: (command: string, args: string[]) => CommandResult;
}

export interface CoreAudioDeviceInventoryProbe {
  bridge_id: typeof COREAUDIO_DEVICE_INVENTORY_BRIDGE_ID;
  platform: NodeJS.Platform;
  available: boolean;
  reason?: string;
  devices: AudioDeviceDescriptor[];
}

export interface AudioDeviceSelection {
  uid?: string;
  expected_label?: string;
  direction: 'input' | 'output';
}

export interface AudioDeviceResolution {
  descriptor?: AudioDeviceDescriptor;
  reason?: string;
  used_fallback_label: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseDevices(stdout: string): AudioDeviceDescriptor[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  const records = isRecord(parsed) && Array.isArray(parsed.devices) ? parsed.devices : [];
  return records.flatMap((value): AudioDeviceDescriptor[] => {
    if (!isRecord(value)) return [];
    const uid = typeof value.uid === 'string' ? value.uid.trim() : '';
    const displayName = typeof value.display_name === 'string' ? value.display_name.trim() : '';
    const direction = value.direction;
    if (
      !uid ||
      !displayName ||
      (direction !== 'input' && direction !== 'output' && direction !== 'duplex')
    ) {
      return [];
    }
    const rates = Array.isArray(value.supported_sample_rates)
      ? value.supported_sample_rates.filter(
          (rate): rate is number => typeof rate === 'number' && Number.isFinite(rate)
        )
      : undefined;
    return [
      {
        uid,
        display_name: displayName,
        direction,
        ...(typeof value.channel_count === 'number' ? { channel_count: value.channel_count } : {}),
        ...(rates && rates.length > 0 ? { supported_sample_rates: rates } : {}),
        is_virtual: Boolean(value.is_virtual),
        ...(typeof value.transport === 'string' ? { transport: value.transport } : {}),
        ...(typeof value.avfoundation_unique_id === 'string'
          ? { avfoundation_unique_id: value.avfoundation_unique_id }
          : {}),
      },
    ];
  });
}

function supportsDirection(
  device: AudioDeviceDescriptor,
  direction: AudioDeviceSelection['direction']
): boolean {
  return device.direction === direction || device.direction === 'duplex';
}

export function resolveAudioDevice(
  devices: readonly AudioDeviceDescriptor[],
  selection: AudioDeviceSelection
): AudioDeviceResolution {
  const directionDevices = devices.filter((device) =>
    supportsDirection(device, selection.direction)
  );
  if (selection.uid?.trim()) {
    const uid = selection.uid.trim();
    const matches = directionDevices.filter((device) => device.uid === uid);
    if (matches.length === 1) return { descriptor: matches[0], used_fallback_label: false };
    return {
      used_fallback_label: false,
      reason:
        matches.length === 0
          ? `audio device UID '${uid}' was not found for ${selection.direction}`
          : `audio device UID '${uid}' is ambiguous`,
    };
  }
  const label = selection.expected_label?.trim();
  if (!label) {
    return {
      used_fallback_label: false,
      reason: `${selection.direction} device UID or exact label is required`,
    };
  }
  const matches = directionDevices.filter((device) => device.display_name === label);
  if (matches.length === 1) return { descriptor: matches[0], used_fallback_label: true };
  return {
    used_fallback_label: true,
    reason:
      matches.length === 0
        ? `audio device exact label '${label}' was not found for ${selection.direction}`
        : `audio device exact label '${label}' is ambiguous; choose a device UID`,
  };
}

export class CoreAudioDeviceInventoryBridge {
  readonly bridge_id = COREAUDIO_DEVICE_INVENTORY_BRIDGE_ID;

  constructor(private readonly options: CoreAudioDeviceInventoryBridgeOptions = {}) {}

  async list(): Promise<AudioDeviceDescriptor[]> {
    if (process.platform !== 'darwin' && !this.options.command_runner) return [];
    const command = this.options.swift_bin ?? 'swift';
    const script =
      this.options.script_path ?? rootResolve('libs/core/coreaudio-device-inventory.swift');
    const result = this.options.command_runner
      ? this.options.command_runner(command, [script])
      : safeExecResult(command, [script], { timeoutMs: 20_000, maxOutputMB: 4 });
    if (result.status !== 0 && !result.stdout.trim()) return [];
    return parseDevices(result.stdout);
  }

  async probe(): Promise<CoreAudioDeviceInventoryProbe> {
    if (process.platform !== 'darwin') {
      return {
        bridge_id: this.bridge_id,
        platform: process.platform,
        available: false,
        reason: `CoreAudio inventory requires macOS; current platform is ${process.platform}`,
        devices: [],
      };
    }
    const devices = await this.list();
    return {
      bridge_id: this.bridge_id,
      platform: process.platform,
      available: devices.length > 0,
      ...(devices.length === 0 ? { reason: 'CoreAudio returned no devices' } : {}),
      devices,
    };
  }
}

export function createCoreAudioDeviceInventoryBridge(
  options: CoreAudioDeviceInventoryBridgeOptions = {}
): CoreAudioDeviceInventoryBridge {
  return new CoreAudioDeviceInventoryBridge(options);
}
