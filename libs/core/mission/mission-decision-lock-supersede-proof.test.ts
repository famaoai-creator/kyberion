import { describe, expect, it } from 'vitest';
import type { ConsumedDecisionLockRecord } from '../customer-decision/store.js';
import {
  decisionLockSupersedeProof,
  isDecisionLockVerifiablySuperseded,
} from './mission-decision-lock.js';

// The boundaries (isDecisionLockVerifiablySuperseded) and the operator
// facade's status read a lock's superseded mark through one proof, so they
// cannot disagree on which marks count.

const BASE = {
  version: '1.0.0',
  consumer: 'mission:MSN-PROOF:task-a',
  mission_id: 'MSN-PROOF',
  task_id: 'task-a',
  status: 'in_progress',
} as unknown as ConsumedDecisionLockRecord;

const MARKED = {
  ...BASE,
  superseded: {
    by_task_id: 'task-b',
    approval_request_id: '0b9d6f2e-3c4a-4d5e-8f60-718293a4b5c6',
    at: '2026-10-29T00:00:00.000Z',
  },
} as ConsumedDecisionLockRecord;

describe('decision lock supersede proof', () => {
  it('has no proof for a lock without a mark', () => {
    expect(decisionLockSupersedeProof(BASE)).toBeUndefined();
    expect(isDecisionLockVerifiablySuperseded(BASE)).toBe(false);
  });

  it('passes the mark to the verifier and agrees with the boundary check', () => {
    const seen: unknown[] = [];
    const verifySuperseded = (...args: unknown[]) => {
      seen.push(args);
      return true;
    };
    expect(decisionLockSupersedeProof(MARKED, { verifySuperseded })).toEqual({
      verified: true,
      by_task_id: 'task-b',
      approval_request_id: '0b9d6f2e-3c4a-4d5e-8f60-718293a4b5c6',
    });
    expect(isDecisionLockVerifiablySuperseded(MARKED, { verifySuperseded })).toBe(true);
    expect(seen[0]).toEqual([
      'MSN-PROOF',
      'task-a',
      { byTaskId: 'task-b', approvalRequestId: '0b9d6f2e-3c4a-4d5e-8f60-718293a4b5c6' },
    ]);
  });

  it('fails closed for a mark the mission does not prove', () => {
    const verifySuperseded = () => false;
    expect(decisionLockSupersedeProof(MARKED, { verifySuperseded })).toEqual({
      verified: false,
      reason: 'unproven',
    });
    expect(isDecisionLockVerifiablySuperseded(MARKED, { verifySuperseded })).toBe(false);
  });
});
