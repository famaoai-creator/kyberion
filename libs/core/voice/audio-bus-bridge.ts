/**
 * Audio-bus bridge seam — virtual audio route backends (BlackHole, Pulse, stub).
 *
 * Callers resolve by id / auto; concrete bus classes stay in provider modules.
 */

import type { AudioBus } from './audio-bus.js';
import { StubAudioBus } from './audio-bus.js';
import { getRegisteredEnv } from '../foundation/env.js';
import { coreSeamCatalog, createSeam, type SeamProviderMetadata } from '../seam.js';

export type AudioBusId = 'stub' | 'blackhole' | 'pulseaudio' | (string & {});

export interface AudioBusCreateOptions {
  input_device_uid?: string;
  output_device_uid?: string;
  expected_device_label?: string;
  session_id?: string;
  source_name?: string;
  sink_name?: string;
}

export interface AudioBusBridge {
  readonly bridge_id: AudioBusId;
  createBus(options?: AudioBusCreateOptions): AudioBus;
}

const audioBusSeam = createSeam<AudioBusBridge>({
  key: 'audio-bus-bridge',
  multiplicity: 'named',
  catalog: coreSeamCatalog,
  owner: 'libs/core/voice/audio-bus-bridge.ts',
});

const registeredDisposers = new Map<string, () => void>();

export function registerAudioBusBridge(
  bridge: AudioBusBridge,
  metadata: SeamProviderMetadata = {
    provenance: 'plugin',
    source: 'audio-bus-extension',
  }
): () => void {
  const id = String(bridge.bridge_id || '').trim();
  if (!id) throw new Error('AudioBusBridge.bridge_id is required');
  const disposeFromSeam = audioBusSeam.register(id, bridge, metadata);
  const dispose = () => {
    disposeFromSeam();
    if (registeredDisposers.get(id) === dispose) registeredDisposers.delete(id);
  };
  registeredDisposers.set(id, dispose);
  return dispose;
}

export function resetAudioBusBridges(): void {
  for (const dispose of registeredDisposers.values()) {
    try {
      dispose();
    } catch {
      /* noop */
    }
  }
  registeredDisposers.clear();
}

export function listAudioBusBridges(): AudioBusBridge[] {
  return audioBusSeam.list().map((provider) => provider.implementation);
}

function kyberionEnv(name: string): string | undefined {
  const value = getRegisteredEnv(name);
  if (value === undefined) return undefined;
  return typeof value === 'boolean' ? (value ? '1' : '0') : String(value);
}

/**
 * Resolve an AudioBus. Explicit id wins; otherwise platform default
 * (darwin→blackhole, linux→pulseaudio, else stub).
 */
export function resolveAudioBus(
  preferred: AudioBusId | undefined = kyberionEnv('KYBERION_AUDIO_BUS') as AudioBusId | undefined,
  options?: AudioBusCreateOptions
): AudioBus {
  const bridges = listAudioBusBridges();
  const pick = (id: string): AudioBusBridge | undefined =>
    bridges.find((bridge) => bridge.bridge_id === id);

  if (preferred) {
    const exact = pick(preferred);
    if (!exact) throw new Error(`[audio-bus] unknown bus id '${preferred}'`);
    return exact.createBus(options);
  }
  const platformDefault =
    process.platform === 'darwin'
      ? 'blackhole'
      : process.platform === 'linux'
        ? 'pulseaudio'
        : 'stub';
  return (
    pick(platformDefault) ||
    pick('stub') || { createBus: () => new StubAudioBus() }
  ).createBus(options);
}
