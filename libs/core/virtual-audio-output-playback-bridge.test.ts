import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => {
  const createVirtualDeviceInventoryBridge = vi.fn();
  const safeExec = vi.fn();
  const safeWriteFile = vi.fn();
  return { createVirtualDeviceInventoryBridge, safeExec, safeWriteFile };
});

vi.mock('./virtual-device-inventory-bridge.js', () => ({
  createVirtualDeviceInventoryBridge: mocks.createVirtualDeviceInventoryBridge,
}));

vi.mock('./secure-io.js', () => ({
  safeExec: mocks.safeExec,
  buildSafeExecEnv: vi.fn(() => ({})),
  safeMkdir: vi.fn(),
  safeWriteFile: mocks.safeWriteFile,
  safeRmSync: vi.fn(),
  safeCreateExclusiveFileSync: vi.fn(),
  safeExistsSync: vi.fn(() => false),
  safeReadFile: vi.fn(),
  safeUnlink: vi.fn(),
}));

describe('createVirtualAudioOutputPlaybackBridge', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'darwin',
    });
    mocks.createVirtualDeviceInventoryBridge.mockReturnValue({
      bridge_id: 'virtual-device-inventory-bridge',
      probe: vi.fn().mockResolvedValue({
        bridge_id: 'virtual-device-inventory-bridge',
        platform: 'darwin',
        available: true,
        inventory: {
          audio_inputs: [],
          audio_outputs: [
            {
              kind: 'audio-output',
              name: 'Built-in Output',
              platform: 'darwin',
              source: 'system_profiler',
              available: true,
            },
            {
              kind: 'audio-output',
              name: 'HDMI',
              platform: 'darwin',
              source: 'system_profiler',
              available: true,
            },
          ],
          cameras: [],
          virtual_audio_devices: [],
          virtual_cameras: [],
          notes: [],
        },
      }),
    });
    mocks.safeExec.mockReturnValue('{"status":"ok"}');
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: originalPlatform,
    });
  });

  it('plays a tone through each selected output', async () => {
    const { createVirtualAudioOutputPlaybackBridge } =
      await import('./virtual-audio-output-playback-bridge.js');
    const bridge = createVirtualAudioOutputPlaybackBridge();
    const result = await bridge.playOnOutputs(['Built-in Output', 'HDMI']);

    expect(result.outputs.map((entry) => entry.device_name)).toEqual(['Built-in Output', 'HDMI']);
    expect(result.outputs.every((entry) => entry.status === 'played')).toBe(true);
    expect(mocks.safeExec).toHaveBeenCalledTimes(2);
    expect(mocks.safeExec.mock.calls[0]?.[0]).toBe('swift');
  });

  it('plays an existing source file through each selected output', async () => {
    const { createVirtualAudioOutputPlaybackBridge } =
      await import('./virtual-audio-output-playback-bridge.js');
    const bridge = createVirtualAudioOutputPlaybackBridge();
    const result = await bridge.playOnOutputs(['Built-in Output'], {
      source_path: '/tmp/voice-generation/req-1.wav',
    });

    expect(result.outputs).toHaveLength(1);
    expect(result.outputs[0]).toEqual(
      expect.objectContaining({
        device_name: 'Built-in Output',
        status: 'played',
        source_path: '/tmp/voice-generation/req-1.wav',
        tone_path: '/tmp/voice-generation/req-1.wav',
      })
    );
    expect(mocks.safeExec.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining([
        '--device',
        'Built-in Output',
        '--tone-path',
        '/tmp/voice-generation/req-1.wav',
      ])
    );
  });

  it('plays a pcm stream by converting it to a wav temp file', async () => {
    const { createVirtualAudioOutputPlaybackBridge } =
      await import('./virtual-audio-output-playback-bridge.js');
    const bridge = createVirtualAudioOutputPlaybackBridge();
    const result = await bridge.playStream(
      (async function* () {
        yield {
          format: {
            encoding: 'pcm_s16le' as const,
            sample_rate_hz: 16000,
            channels: 1,
          },
          payload: new Uint8Array([1, 2, 3, 4]),
          ts_ms: 0,
        };
      })(),
      ['Built-in Output']
    );

    expect(result.outputs).toHaveLength(1);
    expect(result.outputs[0]).toEqual(
      expect.objectContaining({
        device_name: 'Built-in Output',
        status: 'played',
      })
    );
    expect(mocks.safeWriteFile).toHaveBeenCalled();
    expect(mocks.safeExec).toHaveBeenCalledTimes(1);
  });
});
