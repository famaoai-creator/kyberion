import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isTestFile, detectFrameworks, generateStrategy, analyzeTestSuite } from './lib';
import * as fs from 'fs';
import * as fsUtils from '@agent/core/fs-utils';

vi.mock('fs');
vi.mock('@agent/core/fs-utils');

describe('test-suite-architect', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('identifies test files', () => {
    expect(isTestFile('src/app.test.ts')).toBe(true);
    expect(isTestFile('__tests__/util.js')).toBe(true);
    expect(isTestFile('src/app.ts')).toBe(false);
  });

  it('detects frameworks from package.json', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ devDependencies: { jest: '^29.0.0' } })
    );

    const frameworks = detectFrameworks('.', ['jest.config.js']);
    expect(frameworks).toContain('jest');
  });

  it('generates strategy', () => {
    const strategy = generateStrategy(
      [],
      0.2,
      ['src/app.ts'],
      ['src/app.ts'],
      ['src/util.test.ts']
    );
    expect(strategy.recommendedFramework).toBe('jest');
    expect(strategy.coverageTarget).toBe(70);
  });

  it('analyzes test suite', () => {
    vi.mocked(fsUtils.getAllFiles).mockReturnValue(['src/app.ts', 'src/app.test.ts']);
    vi.mocked(fs.existsSync).mockReturnValue(false); // No config files

    const analysis = analyzeTestSuite('.');
    expect(analysis.testRatio).toBe(1); // 1 source, 1 test
    expect(analysis.untested).toHaveLength(0);
  });
});
