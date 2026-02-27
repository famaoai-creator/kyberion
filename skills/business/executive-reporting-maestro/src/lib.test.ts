import { describe, it, expect } from 'vitest';
import {
  categorizeResult,
  extractHighlights,
  processReport,
  generateMarkdown,
  SkillResult,
} from './lib.js';

describe('executive-reporting-maestro lib', () => {
  const mockResults: SkillResult[] = [
    {
      skill: 'security-scanner',
      status: 'success',
      data: { score: 95, grade: 'A', recommendations: ['Keep it up'] },
    },
    {
      skill: 'quality-scorer',
      status: 'success',
      data: {
        score: 75,
        grade: 'C',
        recommendations: [{ action: 'Improve tests', priority: 'high' }],
      },
    },
    {
      skill: 'project-health-check',
      status: 'error',
      error: { message: 'Database connection failed' },
    },
  ];

  it('should categorize results by domain', () => {
    expect(categorizeResult(mockResults[0]).domain).toBe('Security');
    expect(categorizeResult(mockResults[1]).domain).toBe('Quality');
    expect(categorizeResult(mockResults[2]).domain).toBe('Project Health');
  });

  it('should extract highlights and risks correctly', () => {
    const { highlights, risks } = extractHighlights(mockResults);
    expect(highlights).toHaveLength(1); // security-scanner score 95
    expect(highlights[0].skill).toBe('security-scanner');
    expect(risks.some((r) => r.type === 'concern')).toBe(true); // quality-scorer score 75
    expect(risks.some((r) => r.type === 'error')).toBe(true); // project-health-check error
    expect(risks.some((r) => r.type === 'recommendation')).toBe(true); // Improve tests
  });

  it('should process full report summary', () => {
    const report = processReport('Test Report', mockResults);
    expect(report.title).toBe('Test Report');
    expect(report.totalResults).toBe(3);
    expect(report.successCount).toBe(2);
    expect(report.errorCount).toBe(1);
    expect(report.domainSummary).toHaveLength(3);
  });

  it('should generate markdown report with icons', () => {
    const report = processReport('Test Report', mockResults);
    const markdown = generateMarkdown(report);
    expect(markdown).toContain('# Test Report');
    expect(markdown).toContain('## Executive Summary');
    expect(markdown).toContain('🚨 **project-health-check**: Database connection failed');
    expect(markdown).toContain('⚠️ **quality-scorer**: Improve tests');
  });

  it('should handle partial invalid results gracefully', () => {
    const mixedResults: any[] = [
      ...mockResults,
      { something: 'else' }, // Missing skill name
      null,
      undefined,
    ];
    const report = processReport('Mixed Report', mixedResults);
    expect(report.totalResults).toBe(3); // Only valid mockResults are processed
    expect(report.successCount).toBe(2);
  });
});
