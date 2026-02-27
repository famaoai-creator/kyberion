import { describe, it, expect } from 'vitest';
import { staticAnalysis } from './lib';

describe('red-team-adversary lib', () => {
  it('should detect hardcoded secrets', () => {
    const content = 'const api_key = "abc12345678";';
    const vulns = staticAnalysis(content, 'test.js');
    expect(vulns.some((v) => v.vector === 'hardcoded-secrets')).toBe(true);
  });
});
