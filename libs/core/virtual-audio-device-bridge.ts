import type { AudioBus, AudioBusProbe } from './audio-bus.js';
import { resolveAudioBus, type AudioBusId } from './audio-bus-resolver.js';
import type { AudioChunk, AudioFormat } from './meeting-session-types.js';
import type { VirtualDeviceInventoryBridge } from './virtual-device-inventory-bridge.js';

export const VIRTUAL_AUDIO_DEVICE_BRIDGE_ID = 'virtual-audio-device-bridge' as const;

export interface VirtualAudioDeviceBridgeOptions {
  /**
   * Override the concrete bus selection. When omitted, the bridge uses
   * the normal host-based resolver.
   */
  preferred_bus?: AudioBusId;
  /** Optional host-visible input device preference when an inventory bridge is available. */
  input_device_preference?: string;
  /** Optional host-visible output device preference when an inventory bridge is available. */
  output_device_preference?: string;
  /**
   * Inject a bus directly for tests or advanced orchestration.
   * When supplied, `preferred_bus` is ignored.
   */
  bus?: AudioBus;
  /** Optional inventory bridge used to enrich probe results with device candidates. */
  inventory_bridge?: VirtualDeviceInventoryBridge;
}

export interface VirtualAudioDeviceBridgeProbe extends AudioBusProbe {
  bridge_id: typeof VIRTUAL_AUDIO_DEVICE_BRIDGE_ID;
  platform: NodeJS.Platform;
  selected_devices?: { input?: string; output?: string };
}

export interface VirtualAudioDeviceBridge {
  readonly bridge_id: typeof VIRTUAL_AUDIO_DEVICE_BRIDGE_ID;
  readonly bus: AudioBus;
  probe(): Promise<VirtualAudioDeviceBridgeProbe>;
  open(format: AudioFormat): Promise<void>;
  inputStream(): AsyncIterable<AudioChunk>;
  writeOutput(stream: AsyncIterable<AudioChunk>): Promise<void>;
  close(): Promise<void>;
}

function normalizeDeviceName(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function pickDeviceByPreference(
  candidates: Array<{ name: string }>,
  preference?: string,
): string | undefined {
  if (candidates.length === 0) return undefined;
  const normalizedPreference = normalizeDeviceName(preference);
  if (!normalizedPreference) return candidates[0]?.name;
  const lowerPreference = normalizedPreference.toLowerCase();
  const exactMatch = candidates.find((candidate) => candidate.name.trim().toLowerCase() === lowerPreference);
  if (exactMatch) return exactMatch.name;
  const containsMatch = candidates.find((candidate) => candidate.name.trim().toLowerCase().includes(lowerPreference));
  if (containsMatch) return containsMatch.name;
  return candidates[0]?.name;
}

/**
 * VirtualAudioDeviceBridge
 *
 * Thin low-level facade above `AudioBus`.
 * It owns bus selection and exposes a stable bridge identity while
 * delegating the actual PCM transport to the concrete bus.
 */
export function createVirtualAudioDeviceBridge(
  options: VirtualAudioDeviceBridgeOptions = {},
): VirtualAudioDeviceBridge {
  const bus = options.bus ?? resolveAudioBus(options.preferred_bus);

  return {
    bridge_id: VIRTUAL_AUDIO_DEVICE_BRIDGE_ID,
    bus,
    async probe(): Promise<VirtualAudioDeviceBridgeProbe> {
      const probe = await bus.probe();
      let devices = probe.devices;
      let selectedDevices: { input?: string; output?: string } | undefined;
      if (options.inventory_bridge) {
        const inventory = await options.inventory_bridge.probe();
        const inputCandidates = inventory.inventory.audio_inputs;
        const outputCandidates = inventory.inventory.audio_outputs;
        const selectedInput =
          pickDeviceByPreference(inputCandidates, options.input_device_preference) ??
          pickDeviceByPreference(inventory.inventory.virtual_audio_devices, options.input_device_preference) ??
          devices?.input;
        const selectedOutput =
          pickDeviceByPreference(outputCandidates, options.output_device_preference) ??
          pickDeviceByPreference(inventory.inventory.virtual_audio_devices, options.output_device_preference) ??
          devices?.output;
        devices = {
          input: devices?.input || selectedInput,
          output: devices?.output || selectedOutput,
        };
        selectedDevices = {
          input: selectedInput,
          output: selectedOutput,
        };
      }
      return {
        ...probe,
        devices,
        selected_devices: selectedDevices,
        bridge_id: VIRTUAL_AUDIO_DEVICE_BRIDGE_ID,
        platform: process.platform,
      };
    },
    async open(format: AudioFormat): Promise<void> {
      await bus.open(format);
    },
    inputStream(): AsyncIterable<AudioChunk> {
      return bus.inputStream();
    },
    async writeOutput(stream: AsyncIterable<AudioChunk>): Promise<void> {
      await bus.writeOutput(stream);
    },
    async close(): Promise<void> {
      await bus.close();
    },
  };
}
