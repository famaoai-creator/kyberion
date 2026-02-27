import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkExistence, checkPackageJson, performAudit } from './lib';
import * as fs from 'fs';

vi.mock('fs');

describe('project-health-check', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('checkExistence matches file patterns', () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => p.toString().endsWith('README.md'));
    expect(checkExistence('.', ['README.md'])).toBe('README.md');
    expect(checkExistence('.', ['LICENSE'])).toBeNull();
  });

  it('checkPackageJson finds deps', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ devDependencies: { jest: '1.0' } })
    );
    expect(checkPackageJson('.', 'test')).toBe(true);
    expect(checkPackageJson('.', 'lint')).toBe(false);
  });

  it('performAudit calculates score', () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      const s = p.toString();
      return s.endsWith('package.json') || s.endsWith('README.md');
    });
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ scripts: { test: 'jest' } }));
    // statSync for directory checks
    vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => false } as any);

    const result = performAudit('.');
    // Should find test (via package.json) and docs (via README.md)
    expect(result.score).toBeGreaterThan(0);
    expect(result.checks).toContainEqual(
      expect.objectContaining({ check: 'Testing Framework', status: 'found' })
    );
    expect(result.checks).toContainEqual(
      expect.objectContaining({ check: 'Documentation', status: 'found' })
    );
  });
});
