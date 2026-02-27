import { describe, it, expect } from 'vitest';
import { validateData } from './lib';

describe('schema-validator lib', () => {
  const schema = {
    type: 'object',
    properties: {
      name: { type: 'string' },
    },
    required: ['name'],
  };

  it('should return valid true for correct data', () => {
    const result = validateData({ name: 'gemini' }, schema);
    expect(result.valid).toBe(true);
  });

  it('should return valid false for incorrect data', () => {
    const result = validateData({ age: 10 }, schema);
    expect(result.valid).toBe(false);
    expect(result.errors).toBeDefined();
  });
});
