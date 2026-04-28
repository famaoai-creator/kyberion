/**
 * Choose an AudioBus implementation for the current host.
 *
 * Order:
 *   1. Explicit `KYBERION_AUDIO_BUS=stub|blackhole|pulseaudio` wins.
 *   2. `darwin` → BlackHole; `linux` → PulseAudio; otherwise → stub.
 *
 * The returned bus is unprobed. Callers should call `probe()` and
 * fall back to `StubAudioBus` if `available=false`.
 */

import type { AudioBus } from './audio-bus.js';
import { StubAudioBus } from './audio-bus.js';
import { BlackHoleAudioBus } from './blackhole-audio-bus.js';
import { PulseAudioBus } from './pulse-audio-bus.js';

export type AudioBusId = 'stub' | 'blackhole' | 'pulseaudio';

export function resolveAudioBus(
  preferred: AudioBusId | undefined = process.env.KYBERION_AUDIO_BUS as AudioBusId | undefined,
): AudioBus {
  if (preferred === 'stub') return new StubAudioBus();
  if (preferred === 'blackhole') return new BlackHoleAudioBus();
  if (preferred === 'pulseaudio') return new PulseAudioBus();
  if (process.platform === 'darwin') return new BlackHoleAudioBus();
  if (process.platform === 'linux') return new PulseAudioBus();
  return new StubAudioBus();
}
