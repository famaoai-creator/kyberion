import { describe, expect, it } from 'vitest';
import { parseBrowserBridgeMessage } from './browser-bridge-input.js';

describe('browser bridge native message boundary', () => {
  it('accepts an object message', () => {
    expect(parseBrowserBridgeMessage('{"type":"ping"}')).toEqual({ type: 'ping' });
  });

  it.each(['[]', 'null', '"ping"'])('rejects a non-object message: %s', (raw) => {
    expect(() => parseBrowserBridgeMessage(raw)).toThrow(
      'browser bridge message must be a JSON object'
    );
  });

  it('rejects dangerous keys before dispatch', () => {
    expect(() => parseBrowserBridgeMessage('{"type":"ping","payload":{"constructor":{}}}')).toThrow(
      'browser bridge message contains a dangerous JSON key'
    );
  });
});
