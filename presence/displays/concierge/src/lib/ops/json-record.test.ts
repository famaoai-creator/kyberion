import { describe, expect, it } from 'vitest';

import { parseJsonRecord } from './json-record';

describe('json-record', () => {
  it('accepts a JSON object', () => {
    expect(parseJsonRecord('{"traceId":"trace-1"}')).toEqual({ traceId: 'trace-1' });
  });

  it('rejects malformed, primitive, and array JSON', () => {
    expect(parseJsonRecord('{')).toBeNull();
    expect(parseJsonRecord('null')).toBeNull();
    expect(parseJsonRecord('[{"traceId":"trace-1"}]')).toBeNull();
  });

  it('rejects dangerous keys before callers inspect the record', () => {
    expect(parseJsonRecord('{"__proto__":{"traceId":"poisoned"}}')).toBeNull();
    expect(parseJsonRecord('{"nested":{"constructor":{}}}')).toBeNull();
  });
});
