import { describe, expect, it } from 'vitest';
import { distillationDisclosure } from './mission-read-model.js';
import type { MissionState } from './mission-types.js';

const base = {
  status: 'completed' as const,
  completed_at: '2026-10-28T00:00:00Z',
  output_path: 'evidence/distillation.md',
};

describe('distillation disclosure', () => {
  it('does not turn legacy completion or contradictory evidence into an LLM claim', () => {
    expect(distillationDisclosure({ distillation: base })).toBe('unknown');
    expect(
      distillationDisclosure({ distillation: { ...base, mode: 'llm', llm_used: false } })
    ).toBe('unknown');
    expect(
      distillationDisclosure({
        distillation: { ...base, mode: 'llm', llm_used: true, structural_reason: 'stub_requested' },
      })
    ).toBe('unknown');
    expect(distillationDisclosure({})).toBe('not_recorded');
  });

  it.each([
    [{ mode: 'llm', llm_used: true }, 'llm'],
    [{ mode: 'structural', llm_used: false }, 'structural'],
    [
      { mode: 'structural', llm_used: false, structural_reason: 'stub_requested' },
      'structural_stub',
    ],
    [
      { mode: 'structural', llm_used: false, structural_reason: 'llm_unavailable' },
      'structural_fallback',
    ],
  ] as const)('exposes the recorded extraction method %j as %s', (fields, expected) => {
    const receipt: MissionState['distillation'] = { ...base, ...fields };
    expect(distillationDisclosure({ distillation: receipt })).toBe(expected);
  });
});
