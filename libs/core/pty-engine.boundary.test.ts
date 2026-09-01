import { describe, expect, it } from 'vitest';
import { parsePtyAdfPayload } from './pty-engine.js';

describe('PTY ADF payload boundary', () => {
  it('accepts a safe object payload', () => {
    expect(parsePtyAdfPayload('{"steps":[]}')).toEqual({ steps: [] });
  });

  it('rejects arrays and nested dangerous keys', () => {
    expect(parsePtyAdfPayload('[]')).toBeUndefined();
    expect(parsePtyAdfPayload('{"steps":[],"meta":{"__proto__":{}}}')).toBeUndefined();
  });
});
