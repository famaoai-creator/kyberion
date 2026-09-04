import { describe, expect, it } from 'vitest';
import { parseSchemaDocument } from './validate.js';

describe('legacy schema loader boundary', () => {
  it('accepts object-root schema documents', () => {
    expect(parseSchemaDocument({ type: 'object', required: ['name'] }, 'example')).toEqual({
      type: 'object',
      required: ['name'],
    });
  });

  it.each([null, [], 'invalid', 42])('rejects non-object schema roots: %p', (value) => {
    expect(() => parseSchemaDocument(value, 'example')).toThrow(
      'example schema must be a JSON object'
    );
  });

  it('rejects dangerous keys before schema consumers receive the document', () => {
    const properties = Object.create(null) as Record<string, unknown>;
    properties.__proto__ = {};
    expect(() => parseSchemaDocument({ properties }, 'example')).toThrow('dangerous JSON key');
  });
});
