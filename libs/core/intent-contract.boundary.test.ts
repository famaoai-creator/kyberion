import { describe, expect, it } from 'vitest';
import { parseIntentModelJsonObject } from './intent-contract.js';

describe('intent model JSON boundary', () => {
  it('extracts a valid object from surrounding model text', () => {
    expect(parseIntentModelJsonObject('Here is the contract: {"intent_id":"hello"}')).toEqual({
      intent_id: 'hello',
    });
  });

  it('rejects arrays and dangerous nested keys', () => {
    expect(parseIntentModelJsonObject('[{"intent_id":"hello"}]')).toBeNull();
    expect(
      parseIntentModelJsonObject('{"intent_id":"hello","meta":{"__proto__":{"x":1}}}')
    ).toBeNull();
  });

  it('returns null for malformed model output', () => {
    expect(parseIntentModelJsonObject('not a JSON contract')).toBeNull();
  });
});
