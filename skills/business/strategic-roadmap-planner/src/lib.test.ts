import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import {
  analyzeCodeComplexity,
  detectTechDebt,
  checkInfrastructure,
  generateRoadmap,
} from './lib.js';
import * as fsUtils from '@agent/core/fs-utils';

vi.mock('child_process', () => ({
  execSync: vi.fn().mockReturnValue('mock commit log'),
}));

describe('strategic-roadmap-planner lib', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should analyze code complexity correctly', () => {
    vi.spyOn(fsUtils, 'getAllFiles').mockReturnValue(['/test/app.ts', '/test/utils.js']);
    vi.spyOn(fs, 'readFileSync').mockReturnValue('line1\nline2\nline3');

    const stats = analyzeCodeComplexity('/test');
    expect(stats.totalFiles).toBe(2);
    expect(stats.totalLines).toBe(6);
    expect(stats.avgFileSize).toBe(3);
  });

  it('should detect tech debt from comments', () => {
    vi.spyOn(fsUtils, 'getAllFiles').mockReturnValue(['/test/debt.ts']);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(
      '// TODO: fix this\n// HACK: temporary fix\n// FIXME: bug here'
    );

    const debt = detectTechDebt('/test');
    expect(debt.totalTodos).toBe(1);
    expect(debt.totalHacks).toBe(1);
    expect(debt.debtScore).toBeGreaterThan(0);
    expect(debt.hotspots).toHaveLength(1);
  });

  it('should check infrastructure state', () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
      if (typeof p === 'string' && (p.includes('tsconfig.json') || p.includes('README.md')))
        return true;
      return false;
    });

    const infra = checkInfrastructure('/test');
    expect(infra.hasTypeChecking).toBe(true);
    expect(infra.hasDocumentation).toBe(true);
    expect(infra.hasCICD).toBe(false);
  });

  it('should generate strategic roadmap based on inputs', () => {
    const complexity = {
      totalFiles: 10,
      totalLines: 1000,
      avgFileSize: 100,
      largeFiles: [],
      languages: {},
    };
    const debt = { totalTodos: 10, totalHacks: 5, totalFixmes: 5, debtScore: 60, hotspots: [] };
    const velocity = { commitsLast4Weeks: 20, commitsLastWeek: 5, avgPerWeek: 5 };
    const infra = {
      hasCICD: false,
      hasTests: false,
      hasLinting: false,
      hasTypeChecking: true,
      hasDocumentation: true,
      hasContainerization: false,
    };

    const result = generateRoadmap(complexity, debt, velocity, infra, 3);
    expect(result.phases).toHaveLength(3);
    expect(result.phases[0].items).toContain('Configure CI/CD pipeline');
    expect(result.priorities.some((p) => p.priority === 'critical')).toBe(true);
  });

  it('should elevate priority when velocity is stalled despite low debt', () => {
    const complexity = {
      totalFiles: 10,
      totalLines: 1000,
      avgFileSize: 100,
      largeFiles: [],
      languages: {},
    };
    const lowDebt = { totalTodos: 1, totalHacks: 0, totalFixmes: 0, debtScore: 2, hotspots: [] };
    const stalledVelocity = { commitsLast4Weeks: 0, commitsLastWeek: 0, avgPerWeek: 0 };
    const infra = {
      hasCICD: true,
      hasTests: true,
      hasLinting: true,
      hasTypeChecking: true,
      hasDocumentation: true,
      hasContainerization: true,
    };

    const result = generateRoadmap(complexity, lowDebt, stalledVelocity, infra, 1);
    expect(
      result.priorities.some(
        (p) => p.priority === 'critical' && p.action.includes('Stalled velocity')
      )
    ).toBe(true);
  });
});
