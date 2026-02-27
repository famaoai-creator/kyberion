import { describe, it, expect } from 'vitest';
import { detectContentType, estimateTokens } from './lib';

describe('asset-token-economist lib', () => {
  it('should detect content type', () => {
    const nl = String.fromCharCode(10);
    const code = ['import os', 'const x = 1;'].join(nl);
    expect(detectContentType(code)).toBe('code');
  });
  it('should estimate tokens', () => {
    const text = 'hello world';
    expect(estimateTokens(text, 'prose')).toBe(3);
  });
});
