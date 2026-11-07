import { describe, expect, it } from 'vitest';
import {
  resolveAudioDevice,
  CoreAudioDeviceInventoryBridge,
} from './coreaudio-device-inventory.js';
import type { AudioDeviceDescriptor } from './audio-route.js';

const blackhole: AudioDeviceDescriptor = {
  uid: 'BlackHole_UID_2ch',
  display_name: 'BlackHole 2ch',
  direction: 'duplex',
  channel_count: 2,
  supported_sample_rates: [16_000, 24_000, 48_000],
  is_virtual: true,
  transport: 'virtual',
};

describe('CoreAudio device inventory', () => {
  it('prefers UID and never falls back to substring matching', () => {
    expect(
      resolveAudioDevice([blackhole], {
        uid: blackhole.uid,
        expected_label: 'BlackHole',
        direction: 'output',
      }).descriptor?.uid
    ).toBe(blackhole.uid);
    expect(
      resolveAudioDevice([blackhole], {
        expected_label: 'BlackHole',
        direction: 'output',
      }).reason
    ).toMatch(/exact label/);
  });

  it('rejects ambiguous exact labels and accepts only an explicit UID', () => {
    const candidates = [blackhole, { ...blackhole, uid: 'BlackHole_UID_other' }];
    expect(
      resolveAudioDevice(candidates, { expected_label: 'BlackHole 2ch', direction: 'input' }).reason
    ).toMatch(/ambiguous/);
    expect(
      resolveAudioDevice(candidates, { uid: 'BlackHole_UID_other', direction: 'input' }).descriptor
        ?.uid
    ).toBe('BlackHole_UID_other');
  });

  it('parses an inventory payload returned by the Swift bridge', async () => {
    const bridge = new CoreAudioDeviceInventoryBridge({
      command_runner: () => ({
        stdout: JSON.stringify({ devices: [blackhole] }),
        stderr: '',
        status: 0,
      }),
    });
    const devices = await bridge.list();
    expect(devices).toEqual([blackhole]);
  });
});
