import { describe, it, expect } from 'vitest';
import { auditHtmlContent } from './lib';

describe('ux-auditor lib', () => {
  it('should detect missing alt tags', () => {
    const content = '<img src="test.png">';
    const findings = auditHtmlContent(content);
    expect(findings.find((f) => f.id === 'img-alt')).toBeDefined();
  });
});
