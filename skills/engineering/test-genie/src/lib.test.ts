import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkDetection, detectTestRunner, DetectionRule, RunnerConfig } from './lib';
import * as fs from 'fs';

vi.mock('fs');

describe('checkDetection', () => {
  const targetDir = '/test/proj';

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('detects package_json_script', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ scripts: { test: 'jest' } }));

    const rule: DetectionRule = { type: 'package_json_script', script: 'test' };
    expect(checkDetection(rule, targetDir)).toBe(true);
  });

  it('detects file_exists', () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => p.toString().endsWith('jest.config.js'));
    const rule: DetectionRule = { type: 'file_exists', path: 'jest.config.js' };
    expect(checkDetection(rule, targetDir)).toBe(true);
  });
});

describe('detectTestRunner', () => {
  const targetDir = '/test/proj';
  const runners: RunnerConfig[] = [
    {
      name: 'jest',
      detection: [{ type: 'file_exists', path: 'jest.config.js' }],
      command: 'jest',
    },
  ];

  it('returns matching runner', () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => p.toString().endsWith('jest.config.js'));
    const runner = detectTestRunner(targetDir, runners);
    expect(runner).toBeDefined();
    expect(runner?.name).toBe('jest');
  });

  it('returns null if no match', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const runner = detectTestRunner(targetDir, runners);
    expect(runner).toBeNull();
  });
});
