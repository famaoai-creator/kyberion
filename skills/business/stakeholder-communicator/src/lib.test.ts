import { describe, it, expect } from 'vitest';
import { translateContent, extractKeyPoints, generateOutput } from './lib.js';

describe('stakeholder-communicator lib', () => {
  const technicalContent = `
    We need to refactor the database migration scripts to reduce latency.
    The technical debt is affecting our 99.9% uptime goal.
    New API deployment will improve response time by 200ms.
  `;

  it('should translate technical terms to business terms', () => {
    const { translated, translations } = translateContent(technicalContent);
    expect(translated).toContain('system modernization');
    expect(translated).toContain('maintenance backlog');
    expect(translations.length).toBeGreaterThanOrEqual(2);
  });

  it('should translate advanced AI and infra terms', () => {
    const aiContent = 'We finished fine-tuning the model on K8s.';
    const { translated } = translateContent(aiContent);
    expect(translated).toContain('AI capability refinement');
    expect(translated).toContain('cloud orchestration platform');
  });

  it('should extract key points like metrics and impact', () => {
    const points = extractKeyPoints(technicalContent);
    expect(points.some((p) => p.type === 'metric' && p.value.includes('99.9%'))).toBe(true);
    expect(points.some((p) => p.type === 'metric' && p.value.includes('200ms'))).toBe(true);
    expect(points.some((p) => p.type === 'impact')).toBe(true);
  });

  it('should generate audience-specific output', () => {
    const points = extractKeyPoints(technicalContent);
    const { translations } = translateContent(technicalContent);

    const output = generateOutput(technicalContent, 'executive', 'email', points, translations);
    expect(output.headline).toContain('Executive Team');
    expect(output.structure.subject).toContain('[Update]');
    expect(output.body).toContain('system modernization');
  });

  it('should generate memo format correctly', () => {
    const output = generateOutput(technicalContent, 'sales', 'memo', [], []);
    expect(output.structure.to).toBe('Sales Team');
    expect(output.structure.from).toBe('Engineering');
  });
});
