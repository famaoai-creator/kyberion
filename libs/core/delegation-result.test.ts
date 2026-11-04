import { describe, expect, it, vi } from 'vitest';

vi.mock('./secret/secret-guard.js', () => ({
  maskActiveSecrets: (text: string) => {
    if (text.includes('BINDING-REFUSED')) throw new Error('[CREDENTIAL_BINDING_REQUIRED] test');
    return text.split('sk-live-SECRET-0042').join('[REDACTED_SECRET]');
  },
  redactActiveSecretsForHostLog: (text: string) =>
    text.split('sk-live-SECRET-0042').join('[REDACTED_SECRET]'),
}));

import {
  buildCancelledDelegationResult,
  buildCompletedDelegationResult,
  buildFailedDelegationResult,
  delegationExecutionStartedFromError,
  delegationResultText,
  DelegationExecutionStartedError,
  DelegationTerminalError,
  markDelegationExecutionStarted,
  markErrorExecutionStarted,
  normalizeDelegationUsage,
  reportDelegationResultMetadata,
  runWithDelegationExecutionTracker,
} from './delegation-result.js';

describe('R2 DelegationResult', () => {
  it('builds a completed result without inventing usage or a served model', () => {
    const result = buildCompletedDelegationResult('done');
    expect(result).toEqual({
      status: 'completed',
      output_text: 'done',
      artifacts: [],
      usage: null,
    });
    expect('served_model' in result).toBe(false);
  });

  it('keeps only measured usage fields and artifact references', () => {
    expect(normalizeDelegationUsage({ input_tokens: 0, output_tokens: Number.NaN })).toEqual({
      input_tokens: 0,
    });
    expect(normalizeDelegationUsage({ output_tokens: -1 })).toBeNull();
    const result = buildCompletedDelegationResult('ok', {
      usage: { total_tokens: 12 },
      served_model: 'model-x',
      artifacts: [{ path: 'active/shared/tmp/a.md', kind: 'report' }, { path: '' }],
    });
    expect(result.usage).toEqual({ total_tokens: 12 });
    expect(result.served_model).toBe('model-x');
    expect(result.artifacts).toEqual([{ path: 'active/shared/tmp/a.md', kind: 'report' }]);
  });

  it('masks active secrets in output_text and error.message', () => {
    expect(buildCompletedDelegationResult('key=sk-live-SECRET-0042').output_text).toBe(
      'key=[REDACTED_SECRET]'
    );
    const failed = buildFailedDelegationResult(new Error('401 unauthorized sk-live-SECRET-0042'));
    expect(failed.error?.message).toBe('401 unauthorized [REDACTED_SECRET]');
  });

  it('never fails the delegation when masking is refused; falls back to host redaction', () => {
    expect(buildCompletedDelegationResult('BINDING-REFUSED sk-live-SECRET-0042').output_text).toBe(
      'BINDING-REFUSED [REDACTED_SECRET]'
    );
  });

  it('reuses the reasoning failure taxonomy', () => {
    const auth = buildFailedDelegationResult(new Error('401 Unauthorized: invalid api key'));
    expect(auth.status).toBe('failed');
    expect(auth.error).toMatchObject({ class: 'auth', retryable: false, allowFailover: true });

    const timeout = buildFailedDelegationResult(new Error('request timed out after 30s'));
    expect(timeout).toMatchObject({ status: 'incomplete', incomplete_reason: 'timeout' });
    expect(timeout.error?.class).toBe('transient');

    expect(buildFailedDelegationResult(new Error('operation aborted by caller')).status).toBe(
      'cancelled'
    );
    expect(buildCancelledDelegationResult('stop').error?.class).toBe('cancelled');
  });

  it('collapses the message to a single line and keeps the long form as detail', () => {
    const failed = buildFailedDelegationResult(new Error('line one\nline two'));
    expect(failed.error?.message).toBe('line one line two');
    expect(failed.error?.detail).toBe('line one\nline two');
  });

  it('forbids failover in the result once execution started', () => {
    const started = buildFailedDelegationResult(
      new DelegationExecutionStartedError('primary', new Error('503 overloaded'))
    );
    expect(started.error).toMatchObject({
      class: 'transient',
      allowFailover: false,
      retryable: false,
    });
  });

  it('projects to the legacy text API', () => {
    expect(delegationResultText(buildCompletedDelegationResult('x'))).toBe('x');
    const failed = buildFailedDelegationResult(new Error('boom'));
    expect(() => delegationResultText(failed)).toThrow(DelegationTerminalError);
    try {
      delegationResultText(failed);
    } catch (error) {
      expect(buildFailedDelegationResult(error)).toBe(failed);
    }
  });
});

describe('R5 execution-start signal', () => {
  it('infers pre-start only for refusals that never ran anything', () => {
    expect(delegationExecutionStartedFromError(new Error('spawn codex ENOENT'))).toBe(false);
    expect(delegationExecutionStartedFromError(new Error('401 unauthorized'))).toBe(false);
    expect(delegationExecutionStartedFromError(new Error('[SUBAGENT_UNAVAILABLE] none'))).toBe(
      false
    );
    expect(delegationExecutionStartedFromError(new Error('provider unavailable'))).toBeUndefined();
    expect(
      delegationExecutionStartedFromError(markErrorExecutionStarted(new Error('401 unauthorized')))
    ).toBe(true);
  });

  it('propagates start marks and metadata to every enclosing tracker', async () => {
    let outerStarted = false;
    const outer = await runWithDelegationExecutionTracker(async (outerTracker) => {
      await runWithDelegationExecutionTracker(async () => {
        markDelegationExecutionStarted();
        reportDelegationResultMetadata({ served_model: 'm1', usage: { output_tokens: 3 } });
      });
      outerStarted = outerTracker.started;
      return outerTracker.metadata;
    });
    expect(outerStarted).toBe(true);
    expect(outer).toEqual({ served_model: 'm1', usage: { output_tokens: 3 } });
    expect(() => markDelegationExecutionStarted()).not.toThrow();
  });
});
