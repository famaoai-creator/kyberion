import { describe, expect, it } from 'vitest';
import { slugify } from './text-utils.js';

describe('slugify', () => {
  it('normalizes to lowercase hyphenated slugs by default', () => {
    expect(slugify('Hello, Kyberion!')).toBe('hello-kyberion');
  });

  it('supports bounded normalized slugs with fallback', () => {
    expect(slugify('///', { fallback: 'finding', maxLength: 24 })).toBe('finding');
  });

  it('supports whitespace-based slugs for legacy identifiers', () => {
    expect(slugify('HYPHENATED Persona', { mode: 'whitespace', separator: '_' })).toBe(
      'HYPHENATED_Persona'
    );
  });
});
