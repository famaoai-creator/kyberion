import { describe, expect, it } from 'vitest';
import { loadSchema, validateCapabilityInput } from './validate.js';

describe('schema validation loader', () => {
  it('loads a governed capability schema and keeps validation behavior', () => {
    expect(loadSchema('capability-input')).toMatchObject({ type: 'object' });
    expect(validateCapabilityInput({}).valid).toBe(false);
  });

  it('rejects schema names that attempt path traversal', () => {
    expect(() => loadSchema('../active/shared/runtime/secret')).toThrow(
      'schema name must be a single filename segment'
    );
  });

  it('does not expose object prototype properties as schemas', () => {
    expect(() => loadSchema('toString')).toThrow('schema not found: toString');
  });
});
