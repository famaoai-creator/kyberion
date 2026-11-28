import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decideFromObservation,
  executeLlmDecideOp,
  SEMANTIC_DECIDE_QUESTION,
} from './semantic-decide.js';
import { registerJudgmentBackend, resetJudgmentBackends } from './judgment-backend.js';
import { registerOrganizationWorkJudgment } from '../organization/organization-operating-model-persistence.js';

const mockPrompt = vi.fn(async () =>
  JSON.stringify({ decision: 'abort', reason: 'reasoning fallback' })
);
vi.mock('./reasoning-backend.js', () => ({
  getReasoningBackend: () => ({
    prompt: mockPrompt,
  }),
}));

afterEach(() => {
  resetJudgmentBackends();
  mockPrompt.mockClear();
});

// AR-07: in-loop decisions prefer selection over generation; anything the
// model says outside the offered options is rejected and callers fall back.

describe('decideFromObservation (AR-07)', () => {
  const OPTIONS = ['#login', 'input[name="email"]', 'form > input:nth-of-type(2)'];

  it('accepts a decision that is one of the offered options', async () => {
    const decision = await decideFromObservation({
      goal: 'pick the email field',
      observation: 'inventory...',
      options: OPTIONS,
      generate: async () =>
        JSON.stringify({ decision: 'input[name="email"]', reason: 'named email' }),
    });
    expect(decision).toEqual({ decision: 'input[name="email"]', reason: 'named email' });
  });

  it('rejects out-of-options replies (caller falls back deterministically)', async () => {
    const decision = await decideFromObservation({
      goal: 'pick the email field',
      observation: 'inventory...',
      options: OPTIONS,
      generate: async () => JSON.stringify({ decision: '#made-up-selector' }),
    });
    expect(decision).toBeNull();
  });

  it('short-circuits when only one option exists (no model call)', async () => {
    const decision = await decideFromObservation({
      goal: 'g',
      observation: 'o',
      options: ['#only'],
      generate: async () => {
        throw new Error('should not be called');
      },
    });
    expect(decision?.decision).toBe('#only');
  });

  it('returns null on backend failure or garbage', async () => {
    expect(
      await decideFromObservation({
        goal: 'g',
        observation: 'o',
        generate: async () => {
          throw new Error('down');
        },
      })
    ).toBeNull();
    expect(
      await decideFromObservation({
        goal: 'g',
        observation: 'o',
        generate: async () => 'not json',
      })
    ).toBeNull();
  });

  it('free-form mode returns the model decision as-is', async () => {
    const decision = await decideFromObservation({
      goal: 'summarize the error class',
      observation: 'ENOSPC on /var',
      generate: async () => '{"decision":"disk-full"}',
    });
    expect(decision?.decision).toBe('disk-full');
  });

  it('rejects non-string decision fields and ignores non-string reasons', async () => {
    await expect(
      decideFromObservation({
        goal: 'g',
        observation: 'o',
        generate: async () => '{"decision": 7, "reason": "wrong type"}',
      })
    ).resolves.toBeNull();

    await expect(
      decideFromObservation({
        goal: 'g',
        observation: 'o',
        generate: async () => '{"decision": "safe", "reason": 7}',
      })
    ).resolves.toEqual({ decision: 'safe' });
  });
});

describe('semantic-decide degradation registry (LC-09)', () => {
  it('records reasons and tracks consecutive model errors, reset on success', async () => {
    const {
      consecutiveSemanticDecideModelErrors,
      getSemanticDecideDegradations,
      resetSemanticDecideDegradations,
    } = await import('./semantic-decide.js');
    resetSemanticDecideDegradations();

    const failing = async () => {
      throw new Error('backend down');
    };
    await decideFromObservation({ goal: 'g1', observation: 'o', generate: failing });
    await decideFromObservation({ goal: 'g2', observation: 'o', generate: failing });
    expect(consecutiveSemanticDecideModelErrors()).toBe(2);

    await decideFromObservation({
      goal: 'g3',
      observation: 'o',
      options: ['a', 'b'],
      generate: async () => '{"decision": "not-an-option"}',
    });
    const reasons = getSemanticDecideDegradations().map((entry) => entry.reason);
    expect(reasons).toEqual(['model_error', 'model_error', 'option_rejected']);
    expect(consecutiveSemanticDecideModelErrors()).toBe(0);

    await decideFromObservation({
      goal: 'g4',
      observation: 'o',
      options: ['a', 'b'],
      generate: async () => '{"decision": "a"}',
    });
    expect(getSemanticDecideDegradations()).toHaveLength(3);

    resetSemanticDecideDegradations();
    expect(getSemanticDecideDegradations()).toHaveLength(0);
  });

  it('routes selection mode through local-only judgment-backend at default confidential tier and enforces tier egress for external-api providers', async () => {
    registerOrganizationWorkJudgment();
    const localJudge = vi.fn(async () => [
      {
        id: SEMANTIC_DECIDE_QUESTION,
        value: '#submit-btn',
        confidence: 0.92,
        calibrated: false,
      },
    ]);
    registerJudgmentBackend({
      judgment_id: 'laya-mlx',
      egress: 'local-only',
      supports: (q) => q.kind === 'choice',
      judge: localJudge,
    });

    const localHit = await decideFromObservation({
      goal: 'Pick the submit button selector',
      observation: '<button id="submit-btn">Save</button>',
      options: ['#cancel-btn', '#submit-btn'],
    });
    expect(localJudge).toHaveBeenCalledTimes(1);
    expect(localHit).toMatchObject({
      decision: '#submit-btn',
      source: 'judgment',
      provider_id: 'laya-mlx',
      confidence: 0.92,
    });

    resetJudgmentBackends();
    registerOrganizationWorkJudgment();
    const externalJudge = vi.fn(async () => [
      {
        id: SEMANTIC_DECIDE_QUESTION,
        value: 'retry',
        confidence: 0.96,
        calibrated: false,
      },
    ]);
    registerJudgmentBackend({
      judgment_id: 'gemini-decision',
      egress: 'external-api',
      supports: (q) => q.kind === 'choice',
      judge: externalJudge,
    });

    // External API is allowed on public tier
    const publicHit = await decideFromObservation({
      goal: 'Choose next action',
      observation: 'Transient HTTP 503',
      options: ['retry', 'abort'],
      tier: 'public',
    });
    expect(externalJudge).toHaveBeenCalledTimes(1);
    expect(publicHit).toMatchObject({
      decision: 'retry',
      source: 'judgment',
      provider_id: 'gemini-decision',
      confidence: 0.96,
    });

    // External API is blocked on personal tier (never called, falls back to reasoning)
    const personalFallback = await decideFromObservation({
      goal: 'Choose next action',
      observation: 'Personal memo',
      options: ['retry', 'abort'],
      tier: 'personal',
    });
    expect(externalJudge).toHaveBeenCalledTimes(1);
    expect(mockPrompt).toHaveBeenCalledTimes(1);
    expect(personalFallback).toMatchObject({ decision: 'abort' });
    expect(personalFallback?.source).not.toBe('judgment');
  });

  it('deduplicates repeated options and exports _source in executeLlmDecideOp', async () => {
    const dedup = await decideFromObservation({
      goal: 'Pick one',
      observation: 'obs',
      options: ['retry', 'retry'],
    });
    expect(dedup).toEqual({ decision: 'retry', reason: 'only candidate' });
    expect(mockPrompt).not.toHaveBeenCalled();

    registerOrganizationWorkJudgment();
    registerJudgmentBackend({
      judgment_id: 'laya-mlx',
      egress: 'local-only',
      supports: (q) => q.kind === 'choice',
      judge: async () => [
        { id: SEMANTIC_DECIDE_QUESTION, value: 'retry', confidence: 0.9, calibrated: false },
      ],
    });
    const out = await executeLlmDecideOp({
      params: {
        goal: 'Choose action',
        options: ['retry', 'abort'],
        export_as: 'next_step',
      },
      ctx: { obs: 'HTTP 503' },
      resolve: (v) => v,
      defaultFromKey: 'obs',
    });
    expect(out.next_step).toMatchObject({ decision: 'retry', source: 'judgment' });
    expect(out.next_step_source).toBe('judgment');
    expect(out.next_step_degraded).toBeNull();
  });
});
