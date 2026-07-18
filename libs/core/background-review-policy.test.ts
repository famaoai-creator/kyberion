import { describe, expect, it } from 'vitest';
import {
  assertBackgroundReviewOperationAllowed,
  buildBackgroundReviewPrompt,
  evaluateBackgroundReviewText,
  isBackgroundReviewOperationAllowed,
} from './background-review-policy.js';

describe('background-review-policy', () => {
  it('rejects transient incident notes from durable knowledge', () => {
    const result = evaluateBackgroundReviewText(
      '一過性のネットワークエラーが発生したため再実行した'
    );
    expect(result).toMatchObject({ allowed: false, rule: 'transient_incident' });
  });

  it('allows durable guidance about handling transient work', () => {
    expect(
      evaluateBackgroundReviewText('Use bounded exponential backoff for transient requests.')
    ).toEqual({ allowed: true });
  });

  it('rejects environment-specific failures and blanket provider claims', () => {
    expect(evaluateBackgroundReviewText('The run failed with ECONNRESET.')).toMatchObject({
      allowed: false,
      rule: 'environment_specific_failure',
    });
    expect(evaluateBackgroundReviewText('This provider is always unreliable.')).toMatchObject({
      allowed: false,
      rule: 'provider_assertion',
    });
  });

  it('enforces the background review operation allowlist', () => {
    expect(isBackgroundReviewOperationAllowed('skill:patch')).toBe(true);
    expect(isBackgroundReviewOperationAllowed('mission:finish')).toBe(false);
    expect(() => assertBackgroundReviewOperationAllowed('mission:finish')).toThrow(
      '[POLICY_VIOLATION]'
    );
  });

  it('builds a prompt that carries the policy into an asynchronous fork', () => {
    const prompt = buildBackgroundReviewPrompt({ sessionId: 'session-1', snapshot: 'snapshot' });
    expect(prompt).toContain('memory:enqueue');
    expect(prompt).toContain('Never record:');
    expect(prompt).toContain('Do not claim that an operation was executed.');
  });
});
