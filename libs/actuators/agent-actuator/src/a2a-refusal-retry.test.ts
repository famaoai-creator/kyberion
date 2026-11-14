import { describe, expect, it } from 'vitest';
import { A2APerformativeNotRoutableError } from '@agent/core/mesh/a2a-bridge';
import { classifyError } from '@agent/core/error-classifier';
import { buildA2ARouteRetryOptions } from './agent-actuator-helpers.js';

const CRAFTED = ['ECONNRESET', 'ETIMEDOUT', 'socket hang up', 'request timeout', 'rate limit 429'];

describe('agent-actuator a2a op retry policy', () => {
  it.each(['propose', 'accept', 'reject', 'result', ...CRAFTED])(
    'does not retry the refusal of performative %j',
    (performative) => {
      const { shouldRetry } = buildA2ARouteRetryOptions();
      expect(shouldRetry?.(new A2APerformativeNotRoutableError(performative))).toBe(false);
    }
  );

  it('does not retry an error that only carries the refusal code, whatever its message says', () => {
    const { shouldRetry } = buildA2ARouteRetryOptions();
    const error = Object.assign(new Error('connect ECONNRESET'), {
      code: 'A2A_PERFORMATIVE_NOT_ROUTABLE',
    });
    expect(shouldRetry?.(error)).toBe(false);
  });

  it.each(CRAFTED)('keeps the caller value %j out of the refusal', (performative) => {
    const refusal = new A2APerformativeNotRoutableError(performative);
    expect(refusal.performative).toBe('unknown');
    expect(refusal.message).not.toContain(performative);
    expect(classifyError(refusal, { recordUnclassified: false })).toMatchObject({
      category: 'invalid_input',
      ruleId: 'a2a.performative-not-routable',
    });
  });

  it('names a declared performative in the refusal', () => {
    expect(new A2APerformativeNotRoutableError('propose').performative).toBe('propose');
  });

  it('still retries a transient transport failure', () => {
    const { shouldRetry } = buildA2ARouteRetryOptions();
    expect(shouldRetry?.(new Error('connect ECONNREFUSED 127.0.0.1:1'))).toBe(true);
  });
});
