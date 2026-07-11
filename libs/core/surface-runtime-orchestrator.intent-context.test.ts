import { describe, expect, it } from 'vitest';
import { buildPipelineIntentContextArgs } from './surface-runtime-orchestrator.js';

// IL-01 acceptance 2 (pipeline seam): the interpreted goal rides into the
// pipeline execution context instead of being dropped at the spawn boundary.
describe('buildPipelineIntentContextArgs (IL-01)', () => {
  const baseContext = (overrides: Record<string, unknown> = {}) =>
    ({
      input: { surfaceText: 'weekly report please', correlationId: 'corr-1' },
      structuredQuery: '',
      compiledFlow: {
        intentContract: {
          intent_id: 'intent-weekly-report',
          source_text: 'weekly report please',
          goal: {
            summary: 'Produce the weekly report',
            success_condition: 'report file exists and covers this week',
          },
        },
      },
      ...overrides,
    }) as never;

  it('threads source text, goal, and intent id as a --context payload', () => {
    const args = buildPipelineIntentContextArgs(baseContext());
    expect(args[0]).toBe('--context');
    const payload = JSON.parse(args[1]);
    expect(payload.intent_goal).toMatchObject({
      source_text: 'weekly report please',
      summary: 'Produce the weekly report',
      success_condition: 'report file exists and covers this week',
      intent_id: 'intent-weekly-report',
    });
  });

  it('returns no args when there is nothing to thread', () => {
    const args = buildPipelineIntentContextArgs({
      input: {},
      structuredQuery: '',
      compiledFlow: undefined,
    } as never);
    expect(args).toEqual([]);
  });

  it('falls back to the raw utterance when no contract goal exists', () => {
    const args = buildPipelineIntentContextArgs({
      input: { surfaceText: 'do the thing' },
      structuredQuery: '',
      compiledFlow: undefined,
    } as never);
    const payload = JSON.parse(args[1]);
    expect(payload.intent_goal.source_text).toBe('do the thing');
    expect(payload.intent_goal.summary).toBeUndefined();
  });
});
