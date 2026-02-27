import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import { analyzeSkillHealth, suggestEvolutions } from './lib';

vi.mock('node:fs');

describe('skill-evolution-engine lib', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should analyze skill health correctly', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readdirSync).mockReturnValue(['main.cjs'] as any);
    vi.mocked(fs.readFileSync).mockReturnValue(`function test() {}
function test2() {}`);

    const health = analyzeSkillHealth('/skills/test');
    expect(health.hasScript).toBe(true);
    expect(health.scriptSize).toBe(2);
    expect(health.functionCount).toBe(2);
  });

  it('should suggest evolutions', () => {
    const health = {
      hasScript: true,
      hasSkillMd: true,
      hasPackageJson: false,
      scriptSize: 500,
      complexity: 'high' as const,
      functionCount: 15,
    };
    const suggestions = suggestEvolutions('test-skill', health);
    expect(suggestions.some((s) => s.type === 'refactor')).toBe(true);
    expect(suggestions.some((s) => s.type === 'structure')).toBe(true);
  });
});
