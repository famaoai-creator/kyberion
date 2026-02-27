import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseSemver, compareVersions, analyzeDependencies } from './lib';
import * as fs from 'fs';

vi.mock('fs');
vi.mock('@agent/core/secure-io');

describe('parseSemver', () => {
  it('parses valid versions', () => {
    expect(parseSemver('1.2.3')).toEqual({ major: 1, minor: 2, patch: '3' });
    expect(parseSemver('^1.2.3')).toEqual({ major: 1, minor: 2, patch: '3' });
    expect(parseSemver('~1.2.3')).toEqual({ major: 1, minor: 2, patch: '3' });
  });
  it('returns null for invalid versions', () => {
    expect(parseSemver('invalid')).toBeNull();
  });
});

describe('compareVersions', () => {
  it('detects major updates', () => {
    expect(compareVersions('1.0.0', '2.0.0').updateType).toBe('major');
  });
  it('detects minor updates', () => {
    expect(compareVersions('1.0.0', '1.1.0').updateType).toBe('minor');
  });
  it('detects patch updates', () => {
    expect(compareVersions('1.0.0', '1.0.1').updateType).toBe('patch');
  });
  it('detects up-to-date', () => {
    expect(compareVersions('1.0.0', '1.0.0').status).toBe('up-to-date');
  });
});

describe('analyzeDependencies', () => {
  const projectDir = '/fake/proj';

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('analyzes dependencies correctly', () => {
    // Mock package.json
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      const pStr = p.toString();
      if (pStr.endsWith('package.json') && !pStr.includes('node_modules')) {
        return JSON.stringify({
          dependencies: {
            'lproject_a-a': '1.0.0',
            'lproject_a-b': '^2.0.0',
          },
        });
      }
      if (pStr.includes('lproject_a-a/package.json')) {
        return JSON.stringify({ version: '1.1.0' }); // Minor update
      }
      if (pStr.includes('lproject_a-b/package.json')) {
        return JSON.stringify({ version: '3.0.0' }); // Major update
      }
      return '{}';
    });

    const report = analyzeDependencies(projectDir);

    expect(report.totalDeps).toBe(2);
    expect(report.minorUpdates).toBe(1); // lproject_a-a
    expect(report.majorUpdates).toBe(1); // lproject_a-b
    expect(report.healthScore).toBeLessThan(100);
  });
});
