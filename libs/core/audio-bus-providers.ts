/**
 * Builtin audio-bus seam providers. Vendor bus classes stay here.
 */

import { StubAudioBus } from './audio-bus.js';
import { BlackHoleAudioBus } from './blackhole-audio-bus.js';
import { getRegisteredEnv } from './foundation/env.js';
import { PulseAudioBus } from './pulse-audio-bus.js';
import { registerAudioBusBridge, type AudioBusCreateOptions } from './audio-bus-bridge.js';

function kyberionEnv(name: string): string | undefined {
  const value = getRegisteredEnv(name);
  if (value === undefined) return undefined;
  return typeof value === 'boolean' ? (value ? '1' : '0') : String(value);
}

function mergeBlackHoleOptions(options?: AudioBusCreateOptions) {
  return {
    ...(kyberionEnv('KYBERION_BLACKHOLE_INPUT_UID')
      ? { input_device_uid: kyberionEnv('KYBERION_BLACKHOLE_INPUT_UID') }
      : {}),
    ...(kyberionEnv('KYBERION_BLACKHOLE_OUTPUT_UID')
      ? { output_device_uid: kyberionEnv('KYBERION_BLACKHOLE_OUTPUT_UID') }
      : {}),
    ...(kyberionEnv('KYBERION_BLACKHOLE_DEVICE_LABEL')
      ? { expected_device_label: kyberionEnv('KYBERION_BLACKHOLE_DEVICE_LABEL') }
      : {}),
    ...(options || {}),
  };
}

let registered = false;

export function registerBuiltinAudioBusBridges(): void {
  if (registered) return;
  registered = true;
  registerAudioBusBridge({
    bridge_id: 'stub',
    createBus: () => new StubAudioBus(),
  });
  registerAudioBusBridge({
    bridge_id: 'blackhole',
    createBus: (options) => new BlackHoleAudioBus(mergeBlackHoleOptions(options)),
  });
  registerAudioBusBridge({
    bridge_id: 'pulseaudio',
    createBus: (options) =>
      new PulseAudioBus({
        ...(options?.source_name ? { source_name: options.source_name } : {}),
        ...(options?.sink_name ? { sink_name: options.sink_name } : {}),
      }),
  });
}

registerBuiltinAudioBusBridges();
