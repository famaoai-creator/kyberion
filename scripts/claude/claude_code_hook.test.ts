import { describe, expect, it } from 'vitest';
import { parseHookPayload } from './claude_code_hook.js';

describe('parseHookPayload', () => {
  it('accepts JSON object payloads', () => {
    expect(parseHookPayload('{"prompt":"hello"}')).toEqual({ prompt: 'hello' });
  });

  it('fails closed for primitive, array, and malformed payloads', () => {
    expect(parseHookPayload('[{"prompt":"hello"}]')).toEqual({});
    expect(parseHookPayload('"hello"')).toEqual({});
    expect(parseHookPayload('{')).toEqual({});
    expect(parseHookPayload('{"__proto__":{"polluted":true}}')).toEqual({});
  });
});
