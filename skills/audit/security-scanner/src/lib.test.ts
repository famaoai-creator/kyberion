import { describe, it, expect } from 'vitest';
import { scanFile } from './lib';

describe('security-scanner', () => {
  it('detects hardcoded API key', () => {
    const code = "const key = 'AIza12345678901234567890123456789012345';";
    const findings = scanFile('test.ts', code);
    expect(findings).toContainEqual(
      expect.objectContaining({
        pattern: 'Generic Hardcoded Secret',
      })
    );
  });

  it('detects eval', () => {
    const code = "eval('alert(1)');";
    const findings = scanFile('test.ts', code);
    expect(findings).toContainEqual(
      expect.objectContaining({
        pattern: 'Dangerous Eval',
      })
    );
  });

  it('detects insecure http', () => {
    const code = "const url = 'http://example.com';";
    const findings = scanFile('test.ts', code);
    expect(findings).toContainEqual(
      expect.objectContaining({
        pattern: 'Insecure HTTP',
      })
    );
  });
});
