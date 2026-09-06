import { describe, expect, it } from 'vitest';
import { parseConciergeMutationResponse } from './mutation-response';

describe('concierge mutation response boundary', () => {
  it('accepts message, result, and upload sample responses', () => {
    expect(
      parseConciergeMutationResponse({
        ok: true,
        message: 'Plugin approved',
        result: { message: 'Mission started' },
        sample: { sample_ref: 'active/profile/voice/sample.wav' },
      })
    ).toEqual({
      message: 'Plugin approved',
      result: { message: 'Mission started' },
      sample: { sample_ref: 'active/profile/voice/sample.wav' },
    });
  });

  it('accepts successful responses without optional fields', () => {
    expect(parseConciergeMutationResponse({ ok: true })).toEqual({});
  });

  it('rejects malformed and unsafe payloads', () => {
    expect(parseConciergeMutationResponse({ ok: false })).toBeUndefined();
    expect(parseConciergeMutationResponse({ ok: true, message: 1 })).toBeUndefined();
    expect(parseConciergeMutationResponse({ ok: true, result: { message: null } })).toBeUndefined();
    const unsafe = JSON.parse('{"ok":true,"message":"ok","constructor":{}}');
    expect(parseConciergeMutationResponse(unsafe)).toBeUndefined();
  });
});
