import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import { execSync } from 'child_process';
import {
  assessCodeQuality,
  assessArchitecture,
  calculateDDScore,
  processTechDD,
  assessTeamMaturity,
} from './lib.js';
import * as fsUtils from '@agent/core/fs-utils';

vi.mock('child_process', () => ({
  execSync: vi.fn().mockReturnValue(' 10 Alice\n 5 Bob\n 2 Charlie'),
}));

describe('tech-dd-analyst lib', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should assess code quality statistics', () => {
    vi.spyOn(fsUtils, 'getAllFiles').mockReturnValue(['/test/main.ts', '/test/lib.js']);
    vi.spyOn(fs, 'readFileSync').mockReturnValue('line1\nline2');

    const stats = assessCodeQuality('/test');
    expect(stats.totalFiles).toBe(2);
    expect(stats.totalLines).toBe(4);
    expect(stats.avgFileSize).toBe(2);
  });

  it('should detect architecture signals', () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
      const pathStr = typeof p === 'string' ? p : '';
      if (pathStr.includes('docker-compose.yml') || pathStr.includes('jest.config.js')) return true;
      return false;
    });

    const arch = assessArchitecture('/test');
    expect(arch.hasMicroservices).toBe(true);
    expect(arch.testFramework).toBe('jest');
    expect(arch.cicd).toBe('none');
  });

  it('should calculate DD score correctly', () => {
    const code = { totalFiles: 50, totalLines: 5000, avgFileSize: 100, languages: {} };
    const team = { contributors: 10, topContributors: [], busFactor: 4, risk: 'low' as const };
    const arch = {
      languages: [],
      frameworks: [],
      tools: [],
      hasMonorepo: false,
      hasMicroservices: false,
      hasDockerCompose: false,
      hasTerraform: false,
      hasK8s: false,
      testFramework: 'vitest',
      cicd: 'github-actions',
    };

    const score = calculateDDScore(code, team, arch);
    // Base 50 + 5 (files>10) + 5 (avgSize<300) + 10 (busFactor>=3) + 10 (test) + 10 (cicd) = 90
    expect(score).toBe(90);
  });

  it('should process full DD and give verdict', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fsUtils, 'getAllFiles').mockReturnValue(['/test/app.ts']);
    vi.spyOn(fs, 'readFileSync').mockReturnValue('dummy content');

    const result = processTechDD('/test');
    expect(result.score).toBeGreaterThan(0);
    expect(result.verdict).toBeDefined();
    expect(result.recommendations.length).toBeDefined();
  });

  it('should flag critical risk when one person does almost everything', () => {
    // 17 total commits, Alice has 15 (88%)
    vi.mocked(execSync).mockReturnValue(' 15 Alice\n 1 Bob\n 1 Charlie');
    const maturity = assessTeamMaturity('/test');
    expect(maturity.risk).toBe('critical');
  });
});
