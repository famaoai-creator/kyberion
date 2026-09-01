import { describe, expect, it } from 'vitest';
import {
  optionalSetupBoolean,
  optionalSetupObject,
  optionalSetupString,
  optionalSetupStringArray,
  requireSetupObject,
  SetupInputError,
} from './setup-input.js';

describe('setup input boundary', () => {
  it.each([null, [], 'text'])('rejects a non-object JSON body: %j', (value) => {
    expect(() => requireSetupObject(value, 'request body')).toThrow(SetupInputError);
  });

  it('requires nested objects instead of coercing arrays', () => {
    expect(() => optionalSetupObject({ tenant: [] }, 'tenant')).toThrow(SetupInputError);
    expect(optionalSetupObject({}, 'tenant')).toBeUndefined();
  });

  it.each([null, 42, {}, []])('rejects non-string fields: %j', (value) => {
    expect(() => optionalSetupString({ name: value }, 'name')).toThrow(SetupInputError);
  });

  it('accepts strings and preserves absent optional fields', () => {
    expect(optionalSetupString({ name: 'Alice' }, 'name')).toBe('Alice');
    expect(optionalSetupString({}, 'name')).toBeUndefined();
  });

  it.each([null, 'true', 1, []])('rejects non-boolean fields: %j', (value) => {
    expect(() => optionalSetupBoolean({ enabled: value }, 'enabled')).toThrow(SetupInputError);
  });

  it.each([null, ['ok', {}], { value: 'ok' }])('rejects invalid string arrays: %j', (value) => {
    expect(() => optionalSetupStringArray({ sample_refs: value }, 'sample_refs')).toThrow(
      SetupInputError
    );
  });

  it('accepts a string array and returns a copy', () => {
    const refs = ['voice/a.wav'];
    const result = optionalSetupStringArray({ sample_refs: refs }, 'sample_refs');

    expect(result).toEqual(refs);
    expect(result).not.toBe(refs);
  });
});
