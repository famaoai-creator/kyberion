import { describe, expect, it } from 'vitest';

import { parseMediaBridgeResponse, parsePdfSplitBridgeResponse } from './media-bridge-response.js';

describe('media bridge response parser', () => {
  it('accepts an object response with a boolean status', () => {
    expect(parseMediaBridgeResponse({ ok: true, count: 2 })).toMatchObject({ ok: true });
  });

  it.each([null, [], 'ok', { ok: 'true' }])('rejects a non-contract root: %j', (value) => {
    expect(() => parseMediaBridgeResponse(value)).toThrow('invalid_media_bridge_response');
  });

  it('accepts a failed bridge response without success payload fields', () => {
    expect(parsePdfSplitBridgeResponse({ ok: false, error: 'bad_password' })).toMatchObject({
      ok: false,
    });
  });

  it('requires a complete split success payload', () => {
    expect(() =>
      parsePdfSplitBridgeResponse({
        ok: true,
        count: 2,
        out_dir: '/tmp/pages',
        pages: ['/tmp/1.pdf'],
      })
    ).toThrow('invalid_pdf_split_bridge_response');
    expect(
      parsePdfSplitBridgeResponse({
        ok: true,
        count: 2,
        out_dir: '/tmp/pages',
        pages: ['/tmp/1.pdf', '/tmp/2.pdf'],
      })
    ).toMatchObject({ ok: true, count: 2 });
  });
});
