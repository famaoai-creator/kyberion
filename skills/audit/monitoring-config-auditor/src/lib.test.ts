import { describe, it, expect } from 'vitest';
import { auditMonitoringContent } from './lib';

describe('monitoring-config-auditor lib', () => {
  it('should detect configured endpoints', () => {
    const content = 'app.get("/health", ...);';
    const results = auditMonitoringContent(content);
    expect(results.find((r) => r.id === 'health-endpoint').status).toBe('configured');
  });
});
