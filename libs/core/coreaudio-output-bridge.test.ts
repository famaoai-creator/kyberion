import { afterEach, describe, expect, it } from 'vitest';
import { CoreAudioOutputBridge } from './coreaudio-output-bridge.js';
import { CoreAudioDeviceInventoryBridge } from './coreaudio-device-inventory.js';
import type { AudioDeviceDescriptor } from './audio-route.js';

const originalPlatform = process.platform;
const format = {
  encoding: 'pcm_s16le' as const,
  sample_rate_hz: 16_000 as const,
  channels: 1 as const,
};
const output: AudioDeviceDescriptor = {
  uid: 'BlackHole_UID_2ch',
  display_name: 'BlackHole 2ch',
  direction: 'output',
  channel_count: 2,
  supported_sample_rates: [16_000, 48_000],
  is_virtual: true,
  transport: 'virtual',
};

function inventory(): CoreAudioDeviceInventoryBridge {
  return new CoreAudioDeviceInventoryBridge({
    command_runner: () => ({
      stdout: JSON.stringify({ devices: [output] }),
      stderr: '',
      status: 0,
    }),
  });
}

describe('CoreAudioOutputBridge', () => {
  afterEach(() =>
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
  );

  it('exposes UID-selected output devices through the route probe', async () => {
    const bridge = new CoreAudioOutputBridge({ inventory_bridge: inventory() });
    const probe = await bridge.probe();
    expect(probe.available).toBe(true);
    expect(probe.devices[0].uid).toBe(output.uid);
  });

  it('rejects format mismatch before starting a helper', async () => {
    const bridge = new CoreAudioOutputBridge({ inventory_bridge: inventory() });
    await expect(bridge.open({ ...format, encoding: 'opus' }, output)).rejects.toThrow(/pcm_s16le/);
    await expect(bridge.open({ ...format, sample_rate_hz: 24_000 }, output)).rejects.toThrow(
      /does not support/
    );
    await expect(
      bridge.open({ ...format, channels: 2 }, { ...output, channel_count: 1 })
    ).rejects.toThrow(/supports 1 channel/);
  });

  it('fails closed on non-macOS', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' });
    const bridge = new CoreAudioOutputBridge({ inventory_bridge: inventory() });
    await expect(bridge.open(format, output)).rejects.toThrow(/requires macOS/);
  });
});
