import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const loadStandardIntentCatalog = vi.fn();
  const resolveIntentResolutionPacket = vi.fn();
  return { loadStandardIntentCatalog, resolveIntentResolutionPacket };
});

vi.mock('./intent-resolution.js', () => ({
  loadStandardIntentCatalog: mocks.loadStandardIntentCatalog,
  resolveIntentResolutionPacket: mocks.resolveIntentResolutionPacket,
}));

describe('intent-contract relevant intent preview', () => {
  it('logs omitted count when the relevant intent preview is truncated', async () => {
    const { logger } = await import('./core.js');
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
    const { summarizeRelevantIntents } = await import('./intent-contract.js');

    mocks.loadStandardIntentCatalog.mockReturnValue(
      Array.from({ length: 10 }, (_, index) => ({
        id: `intent-${index + 1}`,
        description: `Intent ${index + 1}`,
        resolution: { execution_shape: 'task_session' },
        outcome_ids: [`outcome-${index + 1}`],
        intake_requirements: [],
        plan_outline: [],
        specialist_id: `specialist-${index + 1}`,
        trigger_keywords: [],
      }))
    );
    mocks.resolveIntentResolutionPacket.mockReturnValue({
      candidates: Array.from({ length: 10 }, (_, index) => ({
        intent_id: `intent-${index + 1}`,
      })),
    });

    const summary = summarizeRelevantIntents('please do the thing');

    expect(JSON.parse(summary.text)).toHaveLength(6);
    expect(summary.omitted_count).toBe(4);
    expect(infoSpy).toHaveBeenCalledWith(
      '[intent-contract] omitted 4 relevant intent candidate(s) for input preview; limit=6'
    );

    infoSpy.mockRestore();
  });
});
