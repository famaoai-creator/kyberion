import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BlackHoleAudioBus } from './blackhole-audio-bus.js';
import { CoreAudioDeviceInventoryBridge } from './coreaudio-device-inventory.js';
import type { AudioDeviceDescriptor } from './audio-route.js';

const originalPlatform = process.platform;
const format = {
  encoding: 'pcm_s16le' as const,
  sample_rate_hz: 16_000 as const,
  channels: 1 as const,
};
const blackhole: AudioDeviceDescriptor = {
  uid: 'BlackHole_UID_2ch',
  display_name: 'BlackHole 2ch',
  direction: 'duplex',
  channel_count: 2,
  supported_sample_rates: [16_000, 24_000, 48_000],
  is_virtual: true,
  transport: 'virtual',
};

function inventory(): CoreAudioDeviceInventoryBridge {
  return new CoreAudioDeviceInventoryBridge({
    command_runner: () => ({
      stdout: JSON.stringify({ devices: [blackhole] }),
      stderr: '',
      status: 0,
    }),
  });
}

describe('BlackHoleAudioBus characterization and safety', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform });
  });

  it('fails soft on non-macOS', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' });
    const probe = await new BlackHoleAudioBus().probe();
    expect(probe.available).toBe(false);
    expect(probe.reason).toMatch(/requires macOS/);
  });

  it('detects a device listing written to stderr', async () => {
    const probe = await new BlackHoleAudioBus({
      inventory_bridge: inventory(),
      ffmpeg_runner: () => ({
        stdout: '',
        stderr: '[AVFoundation audio devices]\n[0] BlackHole 2ch',
        status: 0,
      }),
    }).probe();
    expect(probe.available).toBe(true);
    expect(probe.device_descriptors?.[0]?.uid).toBe(blackhole.uid);
  });

  it('returns a repair hint when the exact device label is absent', async () => {
    const probe = await new BlackHoleAudioBus({
      inventory_bridge: new CoreAudioDeviceInventoryBridge({
        command_runner: () => ({ stdout: JSON.stringify({ devices: [] }), stderr: '', status: 0 }),
      }),
      ffmpeg_runner: () => ({ stdout: '', stderr: '[AVFoundation audio devices]', status: 0 }),
    }).probe();
    expect(probe.available).toBe(false);
    expect(probe.reason).toMatch(/BlackHole 2ch|device/);
  });

  it('rejects unsupported encodings before starting any process', async () => {
    await expect(new BlackHoleAudioBus().open({ ...format, encoding: 'opus' })).rejects.toThrow(
      /only pcm_s16le/
    );
  });

  it('always cleans capture and leases when output close fails', async () => {
    const bus = new BlackHoleAudioBus();
    const inputQueue = {
      close: vi.fn(),
      metrics: vi.fn(() => ({ depth: 0, dropped_chunks: 0, dropped_ms: 0 })),
    };
    const release = vi.fn();
    const inputProc = { exitCode: 0, signalCode: null };
    const output = { close: vi.fn().mockRejectedValue(new Error('output helper failed')) };

    Object.assign(bus as any, {
      opened: true,
      status: 'healthy',
      output,
      inputQueue,
      inputProc,
      leases: [{ release }],
    });

    await expect(bus.close()).rejects.toThrow('output helper failed');
    expect(output.close).toHaveBeenCalledOnce();
    expect(inputQueue.close).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(bus.health().status).toBe('closed');
  });
});
