import { describe, expect, it } from 'vitest';
import { StubAudioBus } from './audio-bus.js';
import {
  VIRTUAL_AUDIO_DEVICE_BRIDGE_ID,
  createVirtualAudioDeviceBridge,
} from './virtual-audio-device-bridge.js';
import type { AudioChunk, AudioFormat } from './meeting-session-types.js';

function once<T>(iterable: AsyncIterable<T>): Promise<T> {
  return (async () => {
    for await (const item of iterable) return item;
    throw new Error('iterator exhausted before yielding a value');
  })();
}

describe('createVirtualAudioDeviceBridge', () => {
  it('wraps a bus with a stable bridge identity', async () => {
    const bus = new StubAudioBus();
    const bridge = createVirtualAudioDeviceBridge({ bus });

    expect(bridge.bridge_id).toBe(VIRTUAL_AUDIO_DEVICE_BRIDGE_ID);
    expect(bridge.bus.bus_id).toBe('stub');

    const probe = await bridge.probe();
    expect(probe.bridge_id).toBe(VIRTUAL_AUDIO_DEVICE_BRIDGE_ID);
    expect(probe.bus_id).toBe('stub');
    expect(probe.available).toBe(true);
    expect(probe.platform).toBe(process.platform);
  });

  it('delegates audio transport to the selected bus', async () => {
    const bus = new StubAudioBus();
    const bridge = createVirtualAudioDeviceBridge({ bus });
    const format: AudioFormat = {
      encoding: 'pcm_s16le',
      sample_rate_hz: 16000,
      channels: 1,
    };
    const chunk: AudioChunk = {
      format,
      payload: new Uint8Array([1, 2, 3, 4]),
      ts_ms: 42,
    };

    await bridge.open(format);
    const inbound = once(bridge.inputStream());
    await bridge.writeOutput((async function* () {
      yield chunk;
    })());

    await expect(inbound).resolves.toMatchObject({
      format,
      payload: chunk.payload,
      ts_ms: chunk.ts_ms,
    });

    await bridge.close();
  });
});
