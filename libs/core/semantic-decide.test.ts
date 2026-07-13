import { describe, expect, it } from 'vitest';
import { decideFromObservation } from './semantic-decide.js';

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
});
