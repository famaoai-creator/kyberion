import { describe, expect, it } from 'vitest';
import { classifyReasoningFailure } from './reasoning-failure-taxonomy.js';

describe('reasoning failure taxonomy', () => {
  it('retries transient failures and may fail over after exhaustion', () => {
    expect(classifyReasoningFailure(new Error('429 rate limit exceeded'))).toMatchObject({
      class: 'transient',
      retryable: true,
      allowFailover: true,
    });
  });
  it('stops policy failures but fails over provider-local credential failures', () => {
    expect(classifyReasoningFailure(new Error('egress policy denied'))).toMatchObject({
      class: 'policy',
      retryable: false,
      allowFailover: false,
    });
    expect(
      classifyReasoningFailure(new Error('authentication failed: invalid api key'))
    ).toMatchObject({ class: 'auth', retryable: false, allowFailover: true, demoteProvider: true });
  });
  it('allows capability and capacity failures to select a compatible candidate', () => {
    expect(
      classifyReasoningFailure(new Error('[CONTEXT_LIMIT] context window exceeded'))
    ).toMatchObject({ class: 'capacity', allowFailover: true });
    expect(classifyReasoningFailure(new Error('tool use not supported'))).toMatchObject({
      class: 'capability',
      allowFailover: true,
    });
  });
  it('does not retry a governed Codex deadline in place', () => {
    expect(
      classifyReasoningFailure(
        new Error('[codex-cli] structured query failed: [codex-cli] timed out after 120000ms')
      )
    ).toMatchObject({ class: 'transient', retryable: false, allowFailover: true });
  });

  it('fails over immediately when the Claude agent session is unavailable', () => {
    expect(
      classifyReasoningFailure(new Error('claude-agent unavailable: no active session'))
    ).toMatchObject({
      class: 'transient',
      retryable: false,
      allowFailover: true,
      demoteProvider: true,
    });
  });
});
