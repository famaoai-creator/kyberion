import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  safeExec: vi.fn(() => ''),
  safeMkdir: vi.fn(),
  safeWriteFile: vi.fn(),
  sharedTmp: vi.fn((value: string) => `/tmp/${value}`),
  createVirtualDeviceInventoryBridge: vi.fn(),
  createVirtualAudioInputRecordingBridge: vi.fn(),
}));

vi.mock('./secure-io.js', async () => {
  const actual = await vi.importActual<typeof import('./secure-io.js')>('./secure-io.js');
  return {
    ...actual,
    safeExec: mocks.safeExec,
    safeMkdir: mocks.safeMkdir,
    safeWriteFile: mocks.safeWriteFile,
  };
});

vi.mock('./path-resolver.js', async () => {
  const actual = await vi.importActual<typeof import('./path-resolver.js')>('./path-resolver.js');
  return {
    ...actual,
    pathResolver: {
      ...actual.pathResolver,
      sharedTmp: mocks.sharedTmp,
    },
  };
});

vi.mock('./virtual-device-inventory-bridge.js', () => ({
  createVirtualDeviceInventoryBridge: mocks.createVirtualDeviceInventoryBridge,
}));

vi.mock('./virtual-audio-input-recording-bridge.js', () => ({
  createVirtualAudioInputRecordingBridge: mocks.createVirtualAudioInputRecordingBridge,
}));

import { recordVoiceSample } from './voice-sample-recorder.js';

describe('voice-sample-recorder', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.KYBERION_AUDIO_RECORD_COMMAND;
  });

  beforeEach(() => {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'darwin',
    });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: originalPlatform,
    });
  });

  it('uses the microphone bridge when no recording command is configured', async () => {
    const streamChunk = {
      format: {
        encoding: 'pcm_s16le',
        sample_rate_hz: 16000,
        channels: 1,
      },
      payload: new Uint8Array([1, 2, 3, 4]),
      ts_ms: 0,
    };
    mocks.createVirtualDeviceInventoryBridge.mockReturnValue({
      bridge_id: 'virtual-device-inventory-bridge',
      probe: vi.fn(async () => ({
        bridge_id: 'virtual-device-inventory-bridge',
        platform: 'darwin',
        available: true,
        inventory: {
          audio_inputs: [
            {
              kind: 'audio-input',
              name: 'Built-in Microphone',
              platform: 'darwin',
              source: 'system_profiler',
              available: true,
            },
          ],
          audio_outputs: [],
          cameras: [],
          virtual_audio_devices: [],
          virtual_cameras: [],
          notes: [],
        },
      })),
    });
    mocks.createVirtualAudioInputRecordingBridge.mockReturnValue({
      bridge_id: 'virtual-audio-input-recording-bridge',
      probe: vi.fn(async () => ({
        bridge_id: 'virtual-audio-input-recording-bridge',
        platform: 'darwin',
        available: true,
        inputs: ['Built-in Microphone'],
      })),
      captureStream: vi.fn(async function* () {
        yield streamChunk;
      }),
    });

    const result = await recordVoiceSample({
      action: 'record_voice_sample',
      request_id: 'rec-1',
      sample_id: 's1',
      duration_sec: 8,
      prompt_text: 'Tell me about Kyberion.',
    });

    expect(result.status).toBe('succeeded');
    expect(result.selected_input_device).toBe('Built-in Microphone');
    expect(result.backend).toBe('ffmpeg-avfoundation-stream');
    expect(mocks.createVirtualAudioInputRecordingBridge).toHaveBeenCalled();
    expect(mocks.safeExec).not.toHaveBeenCalled();
    expect(mocks.safeWriteFile).toHaveBeenCalledWith(
      '/tmp/voice-sample-recording/rec-1/s1.wav',
      expect.any(Buffer),
    );
  });

  it('returns blocked when no recording command is configured and no bridge is available', async () => {
    mocks.createVirtualDeviceInventoryBridge.mockReturnValue({
      bridge_id: 'virtual-device-inventory-bridge',
      probe: vi.fn(async () => ({
        bridge_id: 'virtual-device-inventory-bridge',
        platform: 'darwin',
        available: false,
        reason: 'no audio inputs found',
        inventory: {
          audio_inputs: [],
          audio_outputs: [],
          cameras: [],
          virtual_audio_devices: [],
          virtual_cameras: [],
          notes: [],
        },
      })),
    });
    mocks.createVirtualAudioInputRecordingBridge.mockReturnValue({
      bridge_id: 'virtual-audio-input-recording-bridge',
      probe: vi.fn(async () => ({
        bridge_id: 'virtual-audio-input-recording-bridge',
        platform: 'darwin',
        available: false,
        reason: 'no audio inputs found',
        inputs: [],
      })),
      captureStream: vi.fn(),
    });

    const result = await recordVoiceSample({
      action: 'record_voice_sample',
      request_id: 'rec-1',
      sample_id: 's1',
      duration_sec: 8,
      prompt_text: 'Tell me about Kyberion.',
    });

    expect(result.status).toBe('blocked');
    expect(result.reason).toContain('no audio inputs found');
  });

  it('invokes the configured shell recording command', async () => {
    process.env.KYBERION_AUDIO_RECORD_COMMAND = 'record-tool --out {{output}} --sec {{duration_sec}}';
    const result = await recordVoiceSample({
      action: 'record_voice_sample',
      request_id: 'rec-2',
      sample_id: 's2',
      duration_sec: 12,
      prompt_text: 'Please read this line.',
    });

    expect(result.status).toBe('succeeded');
    expect(result.output_path).toBe('/tmp/voice-sample-recording/rec-2/s2.wav');
    expect(mocks.safeWriteFile).toHaveBeenCalledWith('/tmp/voice-sample-recording/rec-2/s2.prompt.txt', 'Please read this line.\n');
    expect(mocks.safeExec).toHaveBeenCalledWith(
      expect.any(String),
      ['-lc', 'record-tool --out "/tmp/voice-sample-recording/rec-2/s2.wav" --sec 12'],
      expect.objectContaining({ timeoutMs: 30000 }),
    );
  });
});
