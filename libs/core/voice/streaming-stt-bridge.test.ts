import { describe, expect, it, afterEach } from 'vitest';
import { coreSeamCatalog } from '../seam.js';
import {
  getStreamingSttBridge,
  getStreamingSttBridgeCapabilities,
  listStreamingSttBridges,
  registerStreamingSttBridge,
  resetStreamingSttBridges,
  StubStreamingSpeechToTextBridge,
} from './streaming-stt-bridge.js';

describe('streaming STT seam', () => {
  afterEach(() => resetStreamingSttBridges());

  it('registers the builtin stub normally and rejects duplicate named providers', () => {
    expect(getStreamingSttBridge('stub').bridge_id).toBe('stub');
    expect(
      coreSeamCatalog
        .get('streaming-stt-bridge')!
        .list()
        .map((provider) => provider.id)
    ).toContain('stub');
    expect(() =>
      registerStreamingSttBridge('stub', () => new StubStreamingSpeechToTextBridge())
    ).toThrow(/already registered/);
    const first = registerStreamingSttBridge('test', () => new StubStreamingSpeechToTextBridge());
    expect(() =>
      registerStreamingSttBridge('test', () => new StubStreamingSpeechToTextBridge())
    ).toThrow(/already registered/);
    expect(getStreamingSttBridge('test').bridge_id).toBe('stub');
    first();
    expect(() => getStreamingSttBridge('test')).toThrow(/unknown bridge id/);
  });

  it('removes extensions and their capabilities on reset, restores the builtin, and ignores stale disposers', () => {
    const stale = registerStreamingSttBridge(
      'extension',
      () => new StubStreamingSpeechToTextBridge(),
      { languages: ['ja'], local_only: true }
    );
    expect(getStreamingSttBridgeCapabilities('extension').languages).toEqual(['ja']);
    resetStreamingSttBridges();
    expect(listStreamingSttBridges()).toEqual(['stub']);
    expect(getStreamingSttBridgeCapabilities('extension')).toEqual({});
    expect(getStreamingSttBridge('stub')).toBeInstanceOf(StubStreamingSpeechToTextBridge);
    registerStreamingSttBridge('extension', () => new StubStreamingSpeechToTextBridge(), {
      languages: ['en'],
    });
    stale();
    expect(listStreamingSttBridges()).toContain('extension');
    expect(getStreamingSttBridgeCapabilities('extension').languages).toEqual(['en']);
  });
});
