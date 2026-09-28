import { describe, expect, it } from 'vitest';
import { normalizeVadBridgeResponse, parseVadBridgeLine } from './vad-bridge-protocol.js';

describe('VAD bridge protocol', () => {
  it('accepts bounded probability and control responses', () => {
    expect(normalizeVadBridgeResponse({ prob: 0 })).toEqual({ prob: 0 });
    expect(normalizeVadBridgeResponse({ prob: 1 })).toEqual({ prob: 1 });
    expect(normalizeVadBridgeResponse({ error: 'bridge failed' })).toEqual({
      error: 'bridge failed',
    });
    expect(normalizeVadBridgeResponse({ ok: true })).toEqual({ ok: true });
  });

  it('rejects malformed or out-of-range responses', () => {
    expect(normalizeVadBridgeResponse(null)).toBeNull();
    expect(normalizeVadBridgeResponse([])).toBeNull();
    expect(normalizeVadBridgeResponse({})).toBeNull();
    expect(normalizeVadBridgeResponse({ prob: -0.01 })).toBeNull();
    expect(normalizeVadBridgeResponse({ prob: 1.01 })).toBeNull();
    expect(normalizeVadBridgeResponse({ prob: Number.NaN })).toBeNull();
    expect(normalizeVadBridgeResponse({ prob: '0.9' })).toBeNull();
    expect(normalizeVadBridgeResponse({ error: 7 })).toBeNull();
    expect(normalizeVadBridgeResponse({ ok: 'yes' })).toBeNull();
  });

  it('ignores malformed NDJSON and preserves valid lines', () => {
    expect(parseVadBridgeLine('not-json')).toBeNull();
    expect(parseVadBridgeLine('{"prob":2}')).toBeNull();
    expect(parseVadBridgeLine('{"prob":0.75}')).toEqual({ prob: 0.75 });
  });
});
