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

  it('carries the PA-09 estimated playback length for host-mode mouth motion', () => {
    expect(
      parseVoiceHubSpeechStateResponse({
        ok: true,
        speech: { status: 'speaking', engine_id: 'native', estimated_ms: 2400 },
      })
    ).toEqual({
      ok: true,
      speech: { status: 'speaking', engine_id: 'native', estimated_ms: 2400 },
    });
    expect(
      parseVoiceHubSpeechStateResponse({
        ok: true,
        speech: { status: 'speaking', estimated_ms: -1 },
      })
    ).toBeUndefined();
    expect(
      parseVoiceHubSpeechStateResponse({
        ok: true,
        speech: { status: 'speaking', estimated_ms: '2400' },
      })
    ).toBeUndefined();
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
