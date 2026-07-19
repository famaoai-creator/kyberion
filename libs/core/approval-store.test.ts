import { describe, expect, it } from 'vitest';
import {
  approvalActionCacheKey,
  approvalEventLogicalPath,
  approvalRequestLogicalPath,
  computeApprovalPayloadHash,
  validateHumanFinalDecision,
} from './approval-store.js';

describe('approval-store path normalization', () => {
  it('rejects invalid approval channels', () => {
    expect(() =>
      approvalRequestLogicalPath('../secret', '123e4567-e89b-12d3-a456-426614174000')
    ).toThrow('Invalid approval channel');
    expect(() => approvalEventLogicalPath('terminal/../slack')).toThrow('Invalid approval channel');
  });

  it('rejects invalid approval request ids', () => {
    expect(() => approvalRequestLogicalPath('terminal', '../escape')).toThrow(
      'Invalid approval request id'
    );
  });

  it('binds human final approval to an authenticated decider and exact effect', () => {
    const payloadHash = computeApprovalPayloadHash({ amount: 100, target: 'vendor-a' });
    const accountability = {
      finalDecision: 'human_only' as const,
      payloadHash,
      effectBinding: 'payment:create',
    };

    expect(() => validateHumanFinalDecision({ accountability })).toThrow('human decider');
    expect(() =>
      validateHumanFinalDecision({ accountability, decidedByType: 'ai_agent', authenticated: true })
    ).toThrow('human decider');
    expect(() =>
      validateHumanFinalDecision({
        accountability,
        decidedByType: 'human',
        authenticated: true,
        payloadHash: 'changed',
        effectBinding: 'payment:create',
      })
    ).toThrow('payload hash');
    expect(() =>
      validateHumanFinalDecision({
        accountability,
        decidedByType: 'human',
        authenticated: true,
        payloadHash,
        effectBinding: 'payment:create',
      })
    ).not.toThrow();
  });

  it('canonicalizes payload key order before hashing', () => {
    expect(computeApprovalPayloadHash({ b: 2, a: 1 })).toBe(
      computeApprovalPayloadHash({ a: 1, b: 2 })
    );
  });

  it('normalizes session action cache keys by case and whitespace (KC-03)', () => {
    expect(approvalActionCacheKey({ action: ' Secret:Set ', targetClass: 'Service:GitHub' })).toBe(
      approvalActionCacheKey({ action: 'secret:set', targetClass: 'service:github' })
    );
    expect(approvalActionCacheKey({ action: 'secret:set', targetClass: 'service:github' })).toBe(
      'secret:set::service:github'
    );
  });

  it('rejects session action descriptors missing action or target class (KC-03)', () => {
    expect(() => approvalActionCacheKey({ action: '', targetClass: 'service:github' })).toThrow(
      'action and targetClass'
    );
    expect(() => approvalActionCacheKey({ action: 'secret:set', targetClass: '  ' })).toThrow(
      'action and targetClass'
    );
  });
});
