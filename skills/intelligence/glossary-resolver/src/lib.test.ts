import { describe, it, expect } from 'vitest';
import { resolveGlossary } from './lib';

describe('glossary-resolver lib', () => {
  it('should resolve terms in text', () => {
    const content = 'We use API and SDK for development.';
    const glossary = {
      API: 'Application Programming Interface',
      SDK: 'Software Development Kit',
    };

    const result = resolveGlossary(content, glossary);
    expect(result.resolvedTerms).toBe(2);
    expect(result.content).toContain('API (Application Programming Interface)');
    expect(result.content).toContain('SDK (Software Development Kit)');
  });

  it('should respect word boundaries', () => {
    const content = 'APIs are not API.';
    const glossary = { API: 'Interface' };

    const result = resolveGlossary(content, glossary);
    // Should match 'API' but not 'APIs'
    expect(result.resolvedTerms).toBe(1);
    expect(result.content).toContain('API (Interface)');
    expect(result.content).toContain('APIs are');
  });
});
