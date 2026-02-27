import { describe, it, expect } from 'vitest';
import { classifyDocType } from './lib';

describe('doc-type-classifier lib', () => {
  it('should classify based on keywords', () => {
    const categories = [
      { name: 'Meeting', keywords: ['agenda', 'meeting'] },
      { name: 'Requirement', keywords: ['shall', 'must'] },
    ];
    expect(classifyDocType('This is a meeting agenda.', categories)).toBe('Meeting');
  });
});
