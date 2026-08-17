import { describe, expect, it, afterEach } from 'vitest';
import {
  getStreamingSttBridge,
  registerStreamingSttBridge,
  resetStreamingSttBridges,
  StubStreamingSpeechToTextBridge,
} from './streaming-stt-bridge.js';

describe('streaming STT seam', () => {
  afterEach(() => resetStreamingSttBridges());

  it('keeps the built-in stub shortcut and rejects duplicate named providers', () => {
    expect(getStreamingSttBridge('stub').bridge_id).toBe('stub');
    const first = registerStreamingSttBridge('test', () => new StubStreamingSpeechToTextBridge());
    expect(() =>
      registerStreamingSttBridge('test', () => new StubStreamingSpeechToTextBridge())
    ).toThrow(/already registered/);
    expect(getStreamingSttBridge('test').bridge_id).toBe('stub');
    first();
    expect(() => getStreamingSttBridge('test')).toThrow(/unknown bridge id/);
  });
});
