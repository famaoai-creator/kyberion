import { EventEmitter } from 'node:events';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => {
  const createVirtualDeviceInventoryBridge = vi.fn();
  const safeExec = vi.fn();
  const safeExecResult = vi.fn();
  const spawn = vi.fn();
  return { createVirtualDeviceInventoryBridge, safeExec, safeExecResult, spawn };
});

vi.mock('node:child_process', () => ({
  spawn: mocks.spawn,
}));

vi.mock('./virtual-device-inventory-bridge.js', () => ({
  createVirtualDeviceInventoryBridge: mocks.createVirtualDeviceInventoryBridge,
}));

vi.mock('./secure-io.js', () => ({
  safeExec: mocks.safeExec,
  safeExecResult: mocks.safeExecResult,
  safeMkdir: vi.fn(),
  safeWriteFile: vi.fn(),
}));

describe('createVirtualAudioInputRecordingBridge', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.createVirtualDeviceInventoryBridge.mockReturnValue({
      bridge_id: 'virtual-device-inventory-bridge',
      probe: vi.fn().mockResolvedValue({
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
            {
              kind: 'audio-input',
              name: 'External Mic',
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
      }),
    });
    mocks.safeExecResult.mockReturnValue({
      stdout: '[AVFoundation audio devices]\n[0] Built-in Microphone\n[1] External Mic\n',
      stderr: '',
      status: 0,
    });
    mocks.safeExec.mockReturnValue('{"status":"ok"}');
  });

  it('records a sample from the selected input using ffmpeg', async () => {
    const { createVirtualAudioInputRecordingBridge } = await import('./virtual-audio-input-recording-bridge.js');
    const bridge = createVirtualAudioInputRecordingBridge();
    const result = await bridge.recordOnInputs(['Built-in Microphone'], {
      duration_sec: 3,
      output_path: '/tmp/mic-test.wav',
      prompt_text: 'Please speak clearly.',
    });

    expect(result.recordings).toHaveLength(1);
    expect(result.recordings[0]).toEqual(expect.objectContaining({
      device_name: 'Built-in Microphone',
      status: 'recorded',
      recorded_path: '/tmp/mic-test.wav',
      selected_backend: 'ffmpeg-avfoundation',
    }));
    expect(mocks.safeExec).toHaveBeenCalledWith(
      'ffmpeg',
      expect.arrayContaining(['-f', 'avfoundation', '-t', '3', '/tmp/mic-test.wav']),
      expect.objectContaining({ timeoutMs: 30000 }),
    );
  });

  it('captures a pcm stream from the selected input', async () => {
    const stdout = (async function* () {
      try {
        yield Buffer.from([1, 2, 3, 4]);
      } finally {
        setImmediate(() => {
          fakeChild.emit('close', 0);
        });
      }
    })();
    const fakeChild = new EventEmitter() as EventEmitter & {
      stdout: AsyncIterable<Buffer>;
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    };
    fakeChild.stdout = stdout;
    fakeChild.stderr = new EventEmitter();
    fakeChild.kill = vi.fn();
    mocks.spawn.mockReturnValue(fakeChild);

    const { createVirtualAudioInputRecordingBridge } = await import('./virtual-audio-input-recording-bridge.js');
    const bridge = createVirtualAudioInputRecordingBridge();
    const chunks = [];
    for await (const chunk of bridge.captureStream('Built-in Microphone', { duration_sec: 1 })) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual(expect.objectContaining({
      format: expect.objectContaining({
        encoding: 'pcm_s16le',
        sample_rate_hz: 16000,
        channels: 1,
      }),
    }));
    expect(mocks.spawn).toHaveBeenCalledWith(
      'ffmpeg',
      expect.arrayContaining(['-f', 'avfoundation', '-i', ':0', '-t', '1', '-f', 's16le', 'pipe:1']),
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] }),
    );
  });
});
