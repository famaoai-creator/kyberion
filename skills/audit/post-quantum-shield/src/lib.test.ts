import { describe, it, expect } from 'vitest';
import { scanCryptoContent } from './lib';

describe('post-quantum-shield lib', () => {
  it('should detect vulnerable crypto', () => {
    const content = 'const key = RSA.generate();';
    const findings = scanCryptoContent(content, 'test.js');
    expect(findings.find((f) => f.algorithm === 'RSA')).toBeDefined();
  });
});
