import { describe, expect, it } from 'vitest';
import { parseMcpTextPayload, parseSafeJsonObject } from './mcp-json.js';

describe('MCP JSON boundaries', () => {
  it('accepts a safe object payload', () => {
    expect(parseSafeJsonObject('{"id":"mcp-1","items":[1]}')).toEqual({
      id: 'mcp-1',
      items: [1],
    });
  });

  it('rejects malformed and non-object object payloads', () => {
    expect(parseSafeJsonObject('{')).toBeNull();
    expect(parseSafeJsonObject('[]')).toBeNull();
  });

  it('rejects dangerous object keys without exposing the parsed tree', () => {
    expect(parseSafeJsonObject('{"nested":{"__proto__":{"polluted":true}}}')).toBeNull();
  });

  it('parses safe text payloads and preserves non-JSON text', () => {
    expect(parseMcpTextPayload('{"ok":true}')).toEqual({ ok: true });
    expect(parseMcpTextPayload('plain text')).toBe('plain text');
  });

  it('preserves dangerous JSON as text rather than returning an unsafe tree', () => {
    const payload = '{"__proto__":{"polluted":true}}';
    expect(parseMcpTextPayload(payload)).toBe(payload);
  });
});
