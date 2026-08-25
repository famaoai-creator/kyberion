import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockFiles = vi.hoisted(() => new Map<string, string>());

vi.mock('./secure-io.js', () => ({
  safeAppendFileSync: (filePath: string, data: string) =>
    mockFiles.set(filePath, `${mockFiles.get(filePath) || ''}${data}`),
  safeExistsSync: (filePath: string) => mockFiles.has(filePath),
  safeMkdir: () => {},
  safeReadFile: (filePath: string) => mockFiles.get(filePath) || '',
  loadJson: (filePath: string) => JSON.parse(mockFiles.get(filePath) || 'null'),
  safeWriteFile: (filePath: string, data: string) => mockFiles.set(filePath, data),
}));

describe('model performance index', () => {
  let mod: typeof import('./model-performance-index.js');

  beforeEach(async () => {
    mockFiles.clear();
    vi.resetModules();
    mod = await import('./model-performance-index.js');
  });

  afterEach(() => {
    mockFiles.clear();
  });

  it('learns a bounded model×role score from retrospective outcomes', () => {
    mod.recordModelRoleOutcomes(
      Array.from({ length: 5 }, (_, index) => ({
        mission_id: 'MSN-MODEL-001',
        task_id: `T-${index}`,
        team_role: 'implementer',
        provider: 'openai',
        model_id: 'openai:gpt-5.6-luna',
        final_status: index === 4 ? 'blocked' : 'done',
        recorded_at: new Date().toISOString(),
      }))
    );

    expect(mod.getModelRolePerformance('openai:gpt-5.6-luna', 'implementer')).toMatchObject({
      samples: 5,
      success: 4,
      blocked: 1,
    });
    expect(
      mod.modelPerformanceScoreAdjustment('openai:gpt-5.6-luna', 'implementer')
    ).toBeGreaterThan(0);
  });

  it('accepts explicit user feedback and keeps one sample from changing routing', () => {
    mod.recordModelRoleFeedback({
      modelId: 'anthropic:claude-sonnet-5',
      teamRole: 'planner',
      rating: 5,
      source: 'user',
      comment: 'clear plan',
    });

    expect(mod.getModelRolePerformance('anthropic:claude-sonnet-5', 'planner')).toMatchObject({
      feedback_samples: 1,
      average_rating: 5,
    });
    expect(mod.modelPerformanceScoreAdjustment('anthropic:claude-sonnet-5', 'planner')).toBe(0);
  });

  it('does not inflate objective samples when the same retrospective is replayed', () => {
    const outcome = {
      mission_id: 'MSN-REPLAY-001',
      task_id: 'T-1',
      team_role: 'reviewer',
      model_id: 'openai:gpt-5.6-luna',
      final_status: 'done',
      recorded_at: new Date().toISOString(),
    };

    mod.recordModelRoleOutcomes([outcome]);
    mod.recordModelRoleOutcomes([outcome]);

    expect(mod.getModelRolePerformance(outcome.model_id, outcome.team_role)).toMatchObject({
      samples: 1,
      success: 1,
    });
  });

  it('rejects oversized feedback fields before writing', () => {
    expect(() =>
      mod.recordModelRoleFeedback({
        modelId: 'x'.repeat(161),
        teamRole: 'planner',
        rating: 5,
      })
    ).toThrow('modelId is too long');
  });
});
