import { describe, expect, it } from 'vitest';
import { parseChromeCdpVersionResponse } from './browser-cdp-response.js';

describe('parseChromeCdpVersionResponse', () => {
  it('accepts a Chrome CDP version response with either endpoint marker', () => {
    expect(
      parseChromeCdpVersionResponse({
        Browser: 'Chrome/125.0.0.0',
        webSocketDebuggerUrl: 'ws://127.0.0.1:9555/devtools/browser/abc',
      })
    ).toEqual({
      browser: 'Chrome/125.0.0.0',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9555/devtools/browser/abc',
    });
    expect(parseChromeCdpVersionResponse({ Browser: 'Chrome/125.0.0.0' })).toEqual({
      browser: 'Chrome/125.0.0.0',
    });
  });

  it('rejects non-object or empty/incorrectly typed responses', () => {
    expect(parseChromeCdpVersionResponse(null)).toBeNull();
    expect(parseChromeCdpVersionResponse([])).toBeNull();
    expect(parseChromeCdpVersionResponse({ Browser: 125 })).toBeNull();
    expect(parseChromeCdpVersionResponse({ webSocketDebuggerUrl: '  ' })).toBeNull();
    expect(parseChromeCdpVersionResponse({ ok: true })).toBeNull();
  });
});
