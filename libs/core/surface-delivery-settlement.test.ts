import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  clearSurfaceDeadTarget: vi.fn(),
  deadLetterSurfaceOutboxMessage: vi.fn(),
  markSurfaceDeadTarget: vi.fn(),
  updateSurfaceOutboxMessage: vi.fn(),
  sendOpsAlert: vi.fn(),
}));

vi.mock('./surface-coordination-store.js', () => ({
  clearSurfaceDeadTarget: mocks.clearSurfaceDeadTarget,
  deadLetterSurfaceOutboxMessage: mocks.deadLetterSurfaceOutboxMessage,
  markSurfaceDeadTarget: mocks.markSurfaceDeadTarget,
  updateSurfaceOutboxMessage: mocks.updateSurfaceOutboxMessage,
}));
vi.mock('./ops-alert.js', () => ({ sendOpsAlert: mocks.sendOpsAlert }));

import { recordSurfaceDeliverySuccess, settleSurfaceOutboxFailure } from './surface-delivery.js';

const message = {
  message_id: 'SLACK-OUTBOX-1',
  surface: 'slack',
  correlation_id: 'corr-1',
  channel: 'C123',
  thread_ts: '',
  text: '通知',
  source: 'system' as const,
  created_at: '2026-07-18T00:00:00.000Z',
};

describe('surface delivery settlement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('dead-letters permanent failures, records the dead target, and alerts operators', () => {
    const decision = settleSurfaceOutboxFailure('slack', message, {
      status: 404,
      message: 'unknown channel',
    });

    expect(decision).toMatchObject({ dead_letter: true, attempt_count: 1 });
    expect(mocks.markSurfaceDeadTarget).toHaveBeenCalledWith(
      'slack',
      'C123',
      expect.objectContaining({ kind: 'not_found', retryable: false })
    );
    expect(mocks.deadLetterSurfaceOutboxMessage).toHaveBeenCalledWith(
      'slack',
      'SLACK-OUTBOX-1',
      expect.objectContaining({ kind: 'not_found' })
    );
    expect(mocks.sendOpsAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'critical',
        dedupe_key: 'surface-dead-letter:slack:C123',
      })
    );
    expect(mocks.updateSurfaceOutboxMessage).not.toHaveBeenCalled();
  });

  it('persists retry metadata for transient failures without dead-lettering', () => {
    const decision = settleSurfaceOutboxFailure('slack', message, new Error('ETIMEDOUT'), 1_000);

    expect(decision).toMatchObject({ dead_letter: false, attempt_count: 1 });
    expect(mocks.updateSurfaceOutboxMessage).toHaveBeenCalledWith(
      'slack',
      'SLACK-OUTBOX-1',
      expect.objectContaining({
        attempt_count: 1,
        last_error_kind: 'transient',
        next_attempt_at: new Date(2_000).toISOString(),
      })
    );
    expect(mocks.deadLetterSurfaceOutboxMessage).not.toHaveBeenCalled();
  });

  it('clears a dead-target marker after successful delivery', () => {
    recordSurfaceDeliverySuccess('slack', 'C123');
    expect(mocks.clearSurfaceDeadTarget).toHaveBeenCalledWith('slack', 'C123');
  });
});
