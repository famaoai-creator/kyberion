import { describe, expect, it } from 'vitest';
import {
  parseVoiceInputDevices,
  parseVoiceListenOnceResponse,
  parseVoiceSpeechState,
  parseVoiceStopResponse,
  parseVoiceStatusResponse,
} from './voice-types';

describe('voice response parsers', () => {
  it('accepts valid status, device, and speech shapes', () => {
    expect(
      parseVoiceStatusResponse({
        available: true,
        sttBackends: ['native_speech'],
        selectedSttBackend: 'native_speech',
        inputDevices: [{ id: 0, uid: 'mic', name: 'Mic', isDefault: true }],
        speech: { status: 'idle', startedAt: 1 },
      })
    ).toEqual({
      available: true,
      sttBackends: ['native_speech'],
      selectedSttBackend: 'native_speech',
      inputDevices: [{ id: 0, uid: 'mic', name: 'Mic', isDefault: true }],
      speech: { status: 'idle', startedAt: 1 },
    });
    expect(parseVoiceInputDevices([])).toEqual([]);
    expect(parseVoiceSpeechState({ status: 'speaking', text: 'hello' })).toEqual({
      status: 'speaking',
      text: 'hello',
    });
  });

  it('rejects malformed status and listen-once responses', () => {
    expect(parseVoiceStatusResponse([])).toBeUndefined();
    expect(
      parseVoiceStatusResponse({ available: true, inputDevices: [{ id: '0' }] })
    ).toBeUndefined();
    expect(parseVoiceSpeechState({ status: 'unknown' })).toBeUndefined();
    expect(parseVoiceStopResponse({ ok: true, stopped: false, reason: 'manual_stop' })).toEqual({
      ok: true,
      stopped: false,
      reason: 'manual_stop',
    });
    expect(parseVoiceStopResponse({ ok: true, stopped: false, reason: 42 })).toBeUndefined();
    expect(parseVoiceStopResponse({ ok: true, stopped: false })).toBeUndefined();
    expect(parseVoiceListenOnceResponse({ ok: 'true' })).toBeUndefined();
    expect(parseVoiceListenOnceResponse({ ok: true, spoken: 'yes' })).toBeUndefined();
    expect(
      parseVoiceListenOnceResponse({
        ok: true,
        stt: { ok: true, text: 'hi', locale: 'ja-JP', backend: 'native', is_final: true },
      })
    ).toBeUndefined();
  });
});
