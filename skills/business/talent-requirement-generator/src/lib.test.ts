import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import { detectTechStack, generateJobDescription, processTalentRequirements } from './lib.js';

describe('talent-requirement-generator lib', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should detect tech stack from project files', () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
      const pathStr = typeof p === 'string' ? p : '';
      if (pathStr.includes('package.json') || pathStr.includes('Dockerfile')) return true;
      return false;
    });
    vi.spyOn(fs, 'readFileSync').mockReturnValue(
      JSON.stringify({ dependencies: { react: '18.0.0', express: '4.18.0' } })
    );

    const stack = detectTechStack('/test');
    expect(stack.languages).toContain('JavaScript/TypeScript');
    expect(stack.frameworks).toContain('React');
    expect(stack.frameworks).toContain('Node.js backend');
    expect(stack.tools).toContain('Docker');
  });

  it('should generate correct JD for senior engineer', () => {
    const stack = { languages: ['Python'], frameworks: ['Django'], tools: ['Terraform'] };
    const jd = generateJobDescription('senior-engineer', stack);

    expect(jd.title).toBe('Senior Software Engineer');
    expect(jd.experience).toBe('5-8 years');
    expect(jd.skills).toContain('Python');
    expect(jd.skills).toContain('System Design');
  });

  it('should process full talent requirements', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify({ dependencies: {} }));

    const result = processTalentRequirements('/test', 'tech-lead');
    expect(result.role).toBe('tech-lead');
    expect(result.jobDescription.title).toBe('Technical Lead');
    expect(result.recommendations.length).toBeGreaterThan(0);
    expect(result.recommendations[0].action).toContain('Finalize');
  });

  it('should fallback to default for unknown roles', () => {
    const stack = { languages: ['JavaScript'], frameworks: [], tools: [] };
    const jd = generateJobDescription('data-scientist', stack);
    expect(jd.title).toBe('Software Development Professional');
    expect(jd.skills).toContain('Problem solving');
  });
});
