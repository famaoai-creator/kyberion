import { describe, expect, it } from 'vitest';
import { loadWisdomPolicy } from './mission-distill.js';

describe('wisdom policy catalog', () => {
  it('loads the distillation policy through the governed catalog', () => {
    const policy = loadWisdomPolicy();
    expect(policy?.version).toBe('2.0.0');
    expect(policy?.llm.profiles?.heavy?.command).toBe('codex');
    expect(policy?.tier_mapping.confidential).toBe('knowledge/product/evolution');
  });
});
