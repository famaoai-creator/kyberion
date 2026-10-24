import { describe, expect, it, vi } from 'vitest';
import { cancelApprovalRequestsBySource } from '../governance/approval-store.js';

/**
 * Supersession: a re-proposal of the same action+target must cancel the dot's
 * still-pending approval of that class so asks never stack (repo-guardian
 * triage spam). `cancelApprovalRequestsBySource` matches `source.actionId`,
 * which dot-dispatch stamps as `${action_id}#${target|pipeline_ref}`.
 */
describe('dot approval supersession', () => {
  it('exports a callable cancel-by-source for the dispatch supersession hook', () => {
    expect(typeof cancelApprovalRequestsBySource).toBe('function');
  });

  it('requires at least one source field — an empty filter is a policy violation', () => {
    expect(() => cancelApprovalRequestsBySource('infrastructure_sentinel', { source: {} })).toThrow(
      /POLICY_VIOLATION/
    );
  });

  it('returns no cancellations when nothing pending matches the identity', () => {
    const cancelled = cancelApprovalRequestsBySource('infrastructure_sentinel', {
      source: { agentId: 'dot:test-dot', actionId: 'dot_delegate_work#path:no-such-file' },
      cancelledBy: 'dot:test-dot',
      reason: 'superseded',
    });
    expect(Array.isArray(cancelled)).toBe(true);
    expect(cancelled).toHaveLength(0);
  });
});
