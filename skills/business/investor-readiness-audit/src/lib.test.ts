import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import { internals, processAudit } from './lib.js';

describe('investor-readiness-audit lib', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should find required items correctly', () => {
    const existsSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const check = internals.checkItem('/test', 'README.md');
    expect(check.found).toBe(true);
    existsSpy.mockRestore();
  });

  it('should process full audit and assess readiness with high score', () => {
    const auditSpy = vi.spyOn(internals, 'auditDataRoom').mockReturnValue({
      results: [],
      totalItems: 10,
      foundItems: 10,
      completionPercent: 100,
    });

    const result = processAudit('/test', 'series-a');

    expect(result.completionPercent).toBe(100);
    expect(result.readiness).toBe('ready');

    auditSpy.mockRestore();
  });

  it('should handle completely empty directory gracefully', () => {
    const auditSpy = vi.spyOn(internals, 'auditDataRoom').mockReturnValue({
      results: [],
      totalItems: 10,
      foundItems: 0,
      completionPercent: 0,
    });

    const result = processAudit('/empty', 'ipo');
    expect(result.completionPercent).toBe(0);
    expect(result.readiness).toBe('not_ready');

    auditSpy.mockRestore();
  });
});
