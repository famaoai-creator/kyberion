import { describe, expect, it } from 'vitest';
import {
  parseSafeJsonInput,
  parseSafeJsonObjectInput,
  parseSafeJsonObjectValue,
} from './lib/json-input.js';

describe('peer CLI JSON input boundary', () => {
  it('accepts nested JSON values without coercing their types', () => {
    expect(parseSafeJsonInput('{"items":[1,true,null,{"label":"ok"}]}', 'payload')).toEqual({
      items: [1, true, null, { label: 'ok' }],
    });
  });

  it('rejects malformed JSON and dangerous nested keys', () => {
    expect(() => parseSafeJsonInput('{', 'payload')).toThrow('payload must be valid JSON');
    expect(() => parseSafeJsonInput('{"nested":{"constructor":{}}}', 'payload')).toThrow(
      'payload contains a dangerous JSON key'
    );
  });

  it('requires conversation metadata to be an object', () => {
    expect(parseSafeJsonObjectInput(undefined, 'metadata')).toBeUndefined();
    expect(() => parseSafeJsonObjectInput('[]', 'metadata')).toThrow(
      'metadata must be a JSON object'
    );
    expect(() => parseSafeJsonObjectInput('null', 'metadata')).toThrow(
      'metadata must be a JSON object'
    );
  });

  it('rejects unsafe already-parsed object values', () => {
    const value = {} as Record<string, unknown>;
    Object.defineProperty(value, '__proto__', { value: { polluted: true }, enumerable: true });
    expect(() => parseSafeJsonObjectValue(value, 'relationships')).toThrow(
      'relationships contains a dangerous JSON key'
    );
  });
});
