import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import { checkLicenseProtection, processIPStrategy } from './lib.js';
import * as fsUtils from '@agent/core/fs-utils';

describe('ip-strategist lib', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should detect license protection and risk', () => {
    const existsSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const readSpy = vi
      .spyOn(fs, 'readFileSync')
      .mockReturnValue('This project is licensed under the MIT License.');

    const license = checkLicenseProtection('/test');
    expect(license.protected).toBe(true);
    expect(license.license).toContain('MIT');
    expect(license.risk).toBe('medium');

    existsSpy.mockRestore();
    readSpy.mockRestore();
  });

  it('should process full IP strategy from codebase', () => {
    const existsSpy = vi
      .spyOn(fs, 'existsSync')
      .mockImplementation((p) => typeof p === 'string' && p.includes('LICENSE'));
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation((p) => {
      if (typeof p === 'string' && p.endsWith('algo.ts')) {
        return 'export const complexAlgorithm = (data) => { /* novel approach */ };';
      }
      if (typeof p === 'string' && p.endsWith('LICENSE')) {
        return 'Proprietary - All Rights Reserved';
      }
      return '';
    });

    const getAllFilesSpy = vi
      .spyOn(fsUtils, 'getAllFiles')
      .mockReturnValue(['/test/algo.ts', '/test/LICENSE']);

    const result = processIPStrategy('/test');
    expect(result.totalFindings).toBeGreaterThan(0);
    expect(result.findings.some((f) => f.category === 'Algorithm/Model')).toBe(true);
    expect(result.licenseProtection.license).toBe('Proprietary');
    expect(result.licenseProtection.risk).toBe('low');
    expect(result.recommendations.length).toBeGreaterThan(0);
    expect(result.recommendations[0].action).toBeDefined();

    existsSpy.mockRestore();
    readSpy.mockRestore();
    getAllFilesSpy.mockRestore();
  });

  it('should detect advanced AI terms as Algorithm/Model', () => {
    const readSpy = vi
      .spyOn(fs, 'readFileSync')
      .mockReturnValue('A new transformer model for inference.');
    const getAllFilesSpy = vi.spyOn(fsUtils, 'getAllFiles').mockReturnValue(['/test/ai.ts']);

    const result = processIPStrategy('/test');
    expect(result.findings.some((f) => f.samples.includes('transformer'))).toBe(true);

    readSpy.mockRestore();
    getAllFilesSpy.mockRestore();
  });
});
