import { describe, expect, it } from 'vitest';
import { parseVoiceHubSpeechStateResponse } from './presence-studio-runtime-data.js';

describe('presence studio voice state response boundary', () => {
  it('accepts typed playback state metadata', () => {
    expect(
      parseVoiceHubSpeechStateResponse({
        ok: true,
        speech: { status: 'speaking', text: 'hello', startedAt: 10, pid: 42, engine_id: 'native' },
      })
    ).toEqual({
      ok: true,
      speech: { status: 'speaking', text: 'hello', startedAt: 10, pid: 42, engine_id: 'native' },
    });
  });

  it('fails closed for malformed status, metadata, and dangerous keys', () => {
    expect(
      parseVoiceHubSpeechStateResponse({ ok: true, speech: { status: 'paused' } })
    ).toBeUndefined();
    expect(
      parseVoiceHubSpeechStateResponse({ ok: true, speech: { status: 'idle', pid: '42' } })
    ).toBeUndefined();
    expect(
      parseVoiceHubSpeechStateResponse(
        JSON.parse('{"ok":true,"speech":{"status":"idle","__proto__":{}}}')
      )
    ).toBeUndefined();
  });
});
