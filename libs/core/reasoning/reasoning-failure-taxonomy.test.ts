import { describe, expect, it } from 'vitest';
import { classifyReasoningFailure } from './reasoning-failure-taxonomy.js';

describe('reasoning failure taxonomy', () => {
  it('keeps local credential boundaries out of provider health and preserves policy hard stops', () => {
    for (const code of [
      'SCOPE_DENIED',
      'BINDING_REQUIRED',
      'HOME_INVALID',
      'OWNER_DENIED',
      'KEY_UNAVAILABLE',
    ]) {
      expect(
        classifyReasoningFailure(new Error(`[CREDENTIAL_${code}] credential binding unavailable`))
      ).toEqual({
        class: 'policy',
        retryable: false,
        allowFailover: false,
        demoteProvider: false,
      });
    }
    expect(
      classifyReasoningFailure(
        new Error('[CREDENTIAL_NATIVE_UNSUPPORTED] Isolated native transport unavailable')
      )
    ).toEqual({
      class: 'capability',
      retryable: false,
      allowFailover: true,
      demoteProvider: false,
    });
    expect(
      classifyReasoningFailure(
        new Error('[CREDENTIAL_SCOPE_DENIED] [CREDENTIAL_NATIVE_UNSUPPORTED]')
      )
    ).toMatchObject({ class: 'policy', allowFailover: false });
    expect(
      classifyReasoningFailure(
        new Error(
          '[SUBAGENT_UNAVAILABLE] The selected backend requires a native subagent adopter, but none is available.'
        )
      )
    ).toEqual({
      class: 'capability',
      retryable: false,
      allowFailover: true,
      demoteProvider: false,
    });
  });
  it('separates entitlement and explicit model rate limits from global credentials and policy', () => {
    expect(
      classifyReasoningFailure(new Error('400 Model premium is not supported for this account'))
    ).toMatchObject({
      class: 'entitlement',
      demoteModel: true,
      demoteProvider: false,
      allowFailover: true,
    });
    expect(
      classifyReasoningFailure(
        Object.assign(new Error('429 rate limit'), { rate_limit_scope: 'model' })
      )
    ).toMatchObject({ demoteModel: true, demoteProvider: false });
    expect(classifyReasoningFailure(new Error('400 invalid request'))).toMatchObject({
      class: 'request',
      allowFailover: false,
    });
    expect(
      classifyReasoningFailure(
        new Error('egress policy: Model premium is not supported for this account')
      )
    ).toMatchObject({ class: 'policy', allowFailover: false });
  });

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
