import { describe, it, expect } from 'vitest';
import { analyzeTaskComplexity, selectModel } from './lib';

describe('ai-model-orchestrator lib', () => {
  it('should analyze complexity correctly', () => {
    const result = analyzeTaskComplexity('Implement a new API service');
    expect(result.hardness).toBe('medium');
    expect(result.requiredCapabilities).toContain('code');
  });

  it('should select model based on complexity', () => {
    const complexity: any = {
      hardness: 'low',
      requiredCapabilities: ['text'],
      estimatedTokens: 100,
    };
    const model = selectModel(complexity, 'economy');
    expect(model.tier).toBe('economy');
  });
});
